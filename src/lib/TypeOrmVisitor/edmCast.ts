/**
 * @file Модель типов EDM на стороне компилятора: приведения `cast` и границы диапазона дат.
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ ФАЙЛ. Это две таблицы, а не логика: «какое приведение не может провалиться»
 * и «как называется тип в `CAST` у каждой СУБД». В посетителе они занимали бы сотню строк
 * данных посреди веток обхода, а меняются по своим поводам — при добавлении диалекта
 * или типа EDM, а не при правке трансляции.
 *
 * ЧТО ТАКОЕ ТОТАЛЬНОЕ ПРИВЕДЕНИЕ. По спецификации OData (раздел 5.1.1.8) неудачное приведение
 * даёт `null`. В SQL оно даёт что угодно другое: ошибку уровня СУБД в PostgreSQL, ноль
 * с предупреждением в MySQL, `0.0` в SQLite. Портируемого `TRY_CAST` нет — он есть только
 * в MS SQL. Значит, общей трансляции, соответствующей спецификации, не существует, и поддержать
 * можно только те пары типов, где провал невозможен по определению: расширение числа, GUID
 * или число в строку, дата в дату-время. Всё остальное отвергается целиком, а не транслируется
 * приблизительно, — принцип тот же, что и у `not` в R-01: молча расходиться со спецификацией
 * библиотека не должна.
 *
 * ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ. Приведения к строке из `Edm.Boolean`, `Edm.Double`, `Edm.Binary`
 * и календарных типов не поддержаны, хотя технически не проваливаются: они дают в разных СУБД
 * разный текст (`'true'` против `'1'`, `'1e+30'` против `'1e30'`, шестнадцатеричный дамп
 * против сырых байтов, свой формат даты у каждой). Одинаковое выражение возвращало бы разные
 * строки на разных СУБД — это то же молчаливое расхождение, только этажом ниже.
 */
import type { SqlDialect } from '../types';

/** Как записать приведение в SQL. */
export type CastPlan =
  /** Тип совпадает с исходным: приведения не требуется вовсе. */
  | { form: 'identity' }
  /** Обычная форма `CAST(x AS <тип>)`. */
  | { form: 'cast'; sqlType: string }
  /** Приведение функцией — единственный случай, SQLite (см. `SQLITE_DATETIME`). */
  | { form: 'function'; sqlFunction: string };

/**
 * Причина отказа, если приведение не поддержано.
 *
 * Их две, и различать их важно: `'not-total'` означает «так нельзя в принципе»,
 * а `'unknown-dialect'` — «нельзя на этом драйвере».
 */
export type CastRejection = 'not-total' | 'unknown-dialect';

/** Целые типы EDM по возрастанию ширины: источники для расширяющих приведений. */
const INTEGERS = ['Edm.Byte', 'Edm.SByte', 'Edm.Int16', 'Edm.Int32', 'Edm.Int64'] as const;

/**
 * Тотальные приведения: тип назначения → допустимые исходные типы.
 *
 * Числа расширяются только вверх. Обратное направление (`Edm.Int64` → `Edm.Int32`,
 * `Edm.Double` → `Edm.Int32`) отвергается: оно переполняется или отбрасывает дробную часть,
 * то есть ровно тот провал, для которого в SQL нет портируемого способа вернуть `null`.
 *
 * `Edm.Decimal` → `Edm.Double` считается тотальным: точность теряется, но выражение
 * не проваливается — приближённое число и означает приближение.
 */
const TOTAL_CASTS: Readonly<Record<string, ReadonlySet<string>>> = {
  // GUID и целые числа записываются текстом одинаково во всех пяти СУБД. `Edm.Decimal`
  // тоже: и точка как разделитель, и сохранение хвостовых нулей масштаба общие.
  'Edm.String': new Set<string>([...INTEGERS, 'Edm.Decimal', 'Edm.Guid']),

  'Edm.Int16': new Set<string>(['Edm.Byte', 'Edm.SByte']),
  'Edm.Int32': new Set<string>(['Edm.Byte', 'Edm.SByte', 'Edm.Int16']),
  'Edm.Int64': new Set<string>(['Edm.Byte', 'Edm.SByte', 'Edm.Int16', 'Edm.Int32']),
  'Edm.Decimal': new Set<string>(INTEGERS),
  'Edm.Double': new Set<string>([...INTEGERS, 'Edm.Decimal', 'Edm.Single']),

  // Дата — это полночь того же дня; данных при этом не теряется и не добавляется.
  'Edm.DateTimeOffset': new Set<string>(['Edm.Date']),
};

/**
 * Имена типов в `CAST` по диалектам.
 *
 * Совпадений почти нет: MySQL принимает в `CAST` только `SIGNED` / `UNSIGNED` / `CHAR` /
 * `DECIMAL` / `DATE` / `DATETIME` и (с 8.0.17) `DOUBLE`, у SQLite всего четыре аффинности,
 * у Oracle числа описываются одним `NUMBER` с точностью.
 *
 * `'ansi'` отсутствует намеренно: на незнакомом драйвере имя типа приходится угадывать,
 * а неверная догадка — синтаксическая ошибка в каждом запросе с `cast`. Тот же довод,
 * по которому незнакомый драйвер исключён из переноса вложенной пагинации в SQL.
 *
 * `DECIMAL` в MySQL по умолчанию имеет нулевой масштаб, и это здесь безвредно: источником
 * приведения к `Edm.Decimal` бывают только целые.
 */
const SQL_TYPE_BY_DIALECT: Readonly<Record<string, Readonly<Partial<Record<SqlDialect, string>>>>> =
  {
    'Edm.String': {
      postgres: 'TEXT',
      mysql: 'CHAR',
      sqlite: 'TEXT',
      mssql: 'NVARCHAR(MAX)',
      oracle: 'VARCHAR2(4000)',
    },
    'Edm.Int16': {
      postgres: 'SMALLINT',
      mysql: 'SIGNED',
      sqlite: 'INTEGER',
      mssql: 'SMALLINT',
      oracle: 'NUMBER(5)',
    },
    'Edm.Int32': {
      postgres: 'INTEGER',
      mysql: 'SIGNED',
      sqlite: 'INTEGER',
      mssql: 'INT',
      oracle: 'NUMBER(10)',
    },
    'Edm.Int64': {
      postgres: 'BIGINT',
      mysql: 'SIGNED',
      sqlite: 'INTEGER',
      mssql: 'BIGINT',
      oracle: 'NUMBER(19)',
    },
    'Edm.Decimal': {
      postgres: 'NUMERIC',
      mysql: 'DECIMAL',
      sqlite: 'NUMERIC',
      mssql: 'DECIMAL(38)',
      oracle: 'NUMBER',
    },
    'Edm.Double': {
      postgres: 'DOUBLE PRECISION',
      mysql: 'DOUBLE',
      sqlite: 'REAL',
      mssql: 'FLOAT',
      oracle: 'BINARY_DOUBLE',
    },
    'Edm.DateTimeOffset': {
      postgres: 'TIMESTAMP',
      mysql: 'DATETIME',
      mssql: 'DATETIME2',
      oracle: 'TIMESTAMP',
    },
  };

/**
 * Приведение даты к дате-времени в SQLite делается функцией, а не `CAST`.
 *
 * У SQLite нет календарных типов: `CAST('2020-01-15' AS DATETIME)` разбирает строку
 * по числовой аффинности и даёт `2020` — то есть уничтожает значение вместо приведения.
 * Функция `datetime()` возвращает `'2020-01-15 00:00:00'`, то есть ровно полночь того дня.
 */
const SQLITE_DATETIME = 'datetime';

/**
 * Подбирает форму приведения `cast(x, <тип>)`.
 *
 * @param source - тип EDM исходного выражения.
 * @param target - тип EDM, к которому приводят.
 * @param dialect - целевая СУБД.
 * @returns план записи в SQL либо причину отказа.
 */
export function resolveCast(
  source: string,
  target: string,
  dialect: SqlDialect
): CastPlan | CastRejection {
  // Приведение к собственному типу спецификация разрешает, и SQL для него не нужен вовсе —
  // поэтому оно работает и на незнакомом драйвере.
  if (source === target) {
    return { form: 'identity' };
  }

  if (!TOTAL_CASTS[target]?.has(source)) {
    return 'not-total';
  }

  if (target === 'Edm.DateTimeOffset' && dialect === 'sqlite') {
    return { form: 'function', sqlFunction: SQLITE_DATETIME };
  }

  const sqlType = SQL_TYPE_BY_DIALECT[target]?.[dialect];

  return sqlType ? { form: 'cast', sqlType } : 'unknown-dialect';
}

/**
 * Границы диапазона `Edm.DateTimeOffset`: `mindatetime()` и `maxdatetime()`.
 *
 * ПОЧЕМУ ГРАНИЦА ХРАНИЛИЩА — ТОЧНЫЙ ОТВЕТ, А НЕ ПРИБЛИЖЕНИЕ. Обе функции применяются
 * как сторожевые значения: `x ge mindatetime()` истинно для любой строки. Строк вне
 * диапазона хранения не бывает по определению, поэтому сравнение с границей хранилища
 * даёт тот же ответ, что и сравнение с границей EDM.
 *
 * MYSQL — единственное исключение. Нижняя граница `DATETIME` там 1000-01-01, и значение
 * вне диапазона MySQL превращает в сравнении не в ошибку, а в `NULL`: условие перестало бы
 * выполняться ни для одной строки, то есть `mindatetime()` молча отфильтровал бы всё.
 * Остальные СУБД начало эры EDM представляют: PostgreSQL хранит с 4713 года до н. э.,
 * Oracle — с 4712, `datetime2` в MS SQL — с 0001, SQLite хранит датой текст.
 *
 * ТОЧНОСТЬ. Значение уезжает параметром типа `Date`, как и любой литерал даты-времени
 * в этой библиотеке, поэтому верхняя граница округлена до миллисекунды. Точность
 * та же, что у записанного руками `9999-12-31T23:59:59.999Z`, — отдельного расхождения
 * функция не вносит.
 *
 * @param bound - какая граница нужна.
 * @param dialect - целевая СУБД.
 */
export function dateTimeBound(bound: 'min' | 'max', dialect: SqlDialect): Date {
  if (bound === 'max') {
    return new Date('9999-12-31T23:59:59.999Z');
  }

  return new Date(dialect === 'mysql' ? '1000-01-01T00:00:00Z' : '0001-01-01T00:00:00Z');
}
