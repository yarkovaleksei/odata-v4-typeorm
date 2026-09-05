/**
 * @file Реализация параметра `$search` на уровне SQL TypeORM.
 *
 * Спецификация OData описывает `$search` как полнотекстовый поиск с собственным синтаксисом
 * (`AND`, `OR`, `NOT`, кавычки). Здесь реализована намеренно упрощённая семантика: вся строка
 * целиком ищется как одна подстрока по всем скалярным колонкам корневой сущности.
 *
 * По метаданным сущности собираются текстовые колонки (LIKE по подстроке, регистронезависимо)
 * и числовые (точное равенство, только если строка поиска приводится к числу через `Number`).
 * Условия объединяются через `OR` внутри одной группы `Brackets`, затем добавляются как `andWhere` —
 * скобки здесь обязательны, иначе `OR` «растёк» бы по остальным условиям запроса и
 * `$filter` перестал бы ограничивать выдачу.
 *
 * ОГРАНИЧЕНИЯ:
 * - поиск только по корневой сущности; колонки заджойненных через `$expand` связей не участвуют;
 * - идентификаторы цитируются двойными кавычками (`"alias"."column"`) — это ANSI/PostgreSQL/SQLite,
 *   но не MySQL/MariaDB (обратные кавычки) и не MS SQL в некоторых режимах;
 * - в SQL подставляется `propertyName` (имя свойства класса), а не `databaseName`. Пока имена
 *   совпадают, это работает; при `namingStrategy` вроде snake_case запрос падает
 *   `no such column: Account.firstName`. См. `docs/audit.md`, дефект A-05;
 * - `LIKE` по всем текстовым колонкам без индексов — последовательное сканирование таблицы.
 */
import type { EntityMetadata, ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import { Brackets } from 'typeorm';
import type { QueryParams } from '../../types';

/**
 * Имена типов колонок TypeORM/БД, для которых допустим поиск подстроки через `LIKE`.
 *
 * Список — «белый», а не «чёрный», намеренно: тип колонки в метаданных TypeORM может быть строкой
 * (`'varchar'`), функцией-конструктором (`String`) или специфичным для драйвера алиасом, и перебрать
 * все небезопасные варианты (json, uuid, enum, bytea, date) сложнее, чем перечислить безопасные.
 * Сравнение идёт по нижнему регистру.
 *
 * Осознанно НЕ включены: `uuid`, `json`/`jsonb`, `enum`, `date`/`timestamp`, `bytea`/`blob` —
 * LIKE по ним либо бессмысленен, либо приводит к ошибке приведения типов в строгих СУБД.
 */
export const searchableTextColumnTypes = [
  'varchar',
  'character varying',
  'char',
  'character',
  'text',
  'citext',
  'nvarchar',
  'nchar',
  'ntext',
  'tinytext',
  'mediumtext',
  'longtext',
  // SQLite column.type is String
  'string',
];

/**
 * Числовые типы столбцов, поддерживающие поиск по принципу точного равенства.
 *
 * Для чисел применяется именно равенство, а не LIKE: приведение числовой колонки к строке
 * ради `LIKE '%42%'` убивает индексы и в части СУБД требует явного CAST.
 */
export const searchableNumberColumnTypes = [
  'int',
  'int2',
  'int4',
  'int8',
  'smallint',
  'integer',
  'bigint',
  'decimal',
  'numeric',
  'float',
  'float4',
  'float8',
  'double',
  'double precision',
  'real',
  // SQLite
  'number',
] as const;

export type SearchableTextColumnType = (typeof searchableTextColumnTypes)[number];
export type SearchableNumberColumnType = (typeof searchableNumberColumnTypes)[number];

/**
 * Добавляет к `queryBuilder` условия поиска по всем подходящим скалярным колонкам корневой сущности.
 *
 * @param queryBuilder - построитель, который мутируется на месте (функция ничего не возвращает).
 * @param metadata - метаданные корневой сущности (список колонок и их типов).
 * @param $search - строка поиска (уже может быть обрезана снаружи; пустая — ранний выход).
 * @param alias - SQL-алиас корневой таблицы в запросе.
 *
 * @example
 * // Для сущности User(id: int, name: varchar, email: varchar) и $search='42'
 * // получится примерно такой фрагмент:
 * //   AND (
 * //     LOWER("User"."name")  LIKE LOWER(:textSearchValue) OR
 * //     LOWER("User"."email") LIKE LOWER(:textSearchValue) OR
 * //     "User"."id" = :numberSearchValue
 * //   )
 * // с параметрами { textSearchValue: '%42%', numberSearchValue: 42 }
 */
export const processSearch = <T extends ObjectLiteral = ObjectLiteral>(
  queryBuilder: SelectQueryBuilder<T>,
  metadata: EntityMetadata,
  $search: Required<QueryParams>['$search'],
  alias: string
) => {
  if (!$search || $search.trim() === '') {
    return;
  }

  const searchValue = $search.trim();

  const textColumns: string[] = [];
  const numberColumns: string[] = [];

  for (const column of metadata.columns) {
    // Тип колонки в метаданных бывает и строкой ('varchar'), и конструктором (String, Number) —
    // для SQLite TypeORM выводит именно конструкторы. Приводим оба варианта к строке в нижнем регистре.
    const type = typeof column.type === 'function' ? column.type.name : column.type;
    const typeLower: SearchableTextColumnType | SearchableNumberColumnType = type?.toLowerCase();

    if (searchableTextColumnTypes.includes(typeLower as SearchableTextColumnType)) {
      textColumns.push(column.propertyName);
    } else if (searchableNumberColumnTypes.includes(typeLower as SearchableNumberColumnType)) {
      numberColumns.push(column.propertyName);
    }
  }

  const conditions: string[] = [];
  const parameters: Record<string, string | number> = {};

  // Текстовые условия.
  // Один общий параметр на все колонки (а не по параметру на колонку) — так короче SQL
  // и меньше работы планировщику. LOWER() с обеих сторон даёт регистронезависимость
  // независимо от collation базы; значение дополнительно приводится к нижнему регистру заранее,
  // чтобы LOWER(:param) не зависел от локали сервера БД.
  if (textColumns.length) {
    parameters.textSearchValue = `%${searchValue.toLowerCase()}%`;

    textColumns.forEach((column) => {
      conditions.push(`LOWER("${alias}"."${column}") LIKE LOWER(:textSearchValue)`);
    });
  }

  /**
   * Числовые условия — только если строку поиска можно привести к числу через `Number`.
   *
   * Используется именно `Number`, а не `parseInt`/`parseFloat`: последние отрезают «хвост»
   * (`parseInt('123a') === 123`) и дали бы ложные совпадения по числовым колонкам.
   *
   * @example
   * $search=123    // numericValue = 123  → добавятся условия по числовым колонкам
   * $search=123a   // numericValue = NaN  → числовые колонки пропускаются
   */
  const numericValue = Number(searchValue);

  if (!isNaN(numericValue) && numberColumns.length) {
    parameters.numberSearchValue = numericValue;

    numberColumns.forEach((column) => {
      conditions.push(`"${alias}"."${column}" = :numberSearchValue`);
    });
  }

  // Если подходящих колонок не нашлось — не добавляем ничего. Альтернатива («не нашли — не вернём
  // ничего») сломала бы запросы к сущностям без текстовых полей, а так $search просто игнорируется.
  if (conditions.length) {
    queryBuilder.andWhere(
      new Brackets((qb) => {
        conditions.forEach((condition, idx) => {
          if (idx === 0) {
            qb.where(condition);
          } else {
            qb.orWhere(condition);
          }
        });
      }),
      parameters
    );
  }
};
