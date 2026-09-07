/**
 * @file Реализация параметра `$search` на уровне SQL TypeORM.
 *
 * Выражение разбирается по грамматике OData (`parseSearch`), а здесь дерево превращается
 * в SQL: каждый терм проверяется по набору колонок, а `AND` / `OR` / `NOT` и скобки
 * переносятся в условие один в один.
 *
 * ГДЕ ИСКАТЬ. По умолчанию — все скалярные колонки корневой сущности: текстовые по подстроке
 * (регистронезависимо), числовые по точному равенству. Опция `searchFields` сужает набор
 * и позволяет указать поля связей путём от корня (`'author/name'`). Подзапрос по связи строит
 * общий модуль `relationSource` — тот же, которым пользуются лямбда-операторы `$filter`.
 *
 * NULL И ОТРИЦАНИЕ. Каждое сравнение защищено проверкой `IS NOT NULL`. Без неё `LIKE` по
 * пустой колонке даёт `NULL`, а не `FALSE`, и `NOT` над таким условием отбрасывал бы строки,
 * которые обязан оставлять: «не содержит „ada“» верно и для записи, где поле пустое.
 *
 * ЭКРАНИРОВАНИЕ ШАБЛОНА. `%` и `_` в строке поиска экранируются: запрос `$search=50%`
 * ищет именно «50%», а не «50 и что угодно дальше». Экранирующим символом взят `!`,
 * а не привычная обратная косая черта, из-за литералов: `'\'` в MySQL — незакрытая строка,
 * а `'\\'` в PostgreSQL — уже два символа, и `ESCAPE` такой литерал не принимает.
 *
 * ДВА РЕЖИМА СРАВНЕНИЯ. По умолчанию (`'like'`) ищется подстрока: находит середину слова,
 * но не пользуется индексами — это последовательное сканирование таблицы. Режим `'fulltext'`
 * переключает сравнение на полнотекстовый поиск СУБД: `to_tsvector @@ plainto_tsquery`
 * в PostgreSQL, `MATCH … AGAINST` в MySQL. Он ищет слова целиком (и учитывает словоформы,
 * если задан язык), зато опирается на индекс.
 *
 * Структуру выражения — `AND`, `OR`, `NOT`, скобки — в обоих режимах задаёт разобранное дерево,
 * а не строка, которую отдали бы движку поиска: иначе `$search` вёл бы себя по-разному
 * на разных СУБД. Значение терма поэтому обезвреживается: в MySQL оно берётся в кавычки,
 * чтобы `-слово` не было понято как оператор булева режима.
 *
 * ГДЕ `'fulltext'` НЕ ПРИМЕНЯЕТСЯ. На SQLite (полнотекстовый поиск там — отдельная виртуальная
 * таблица FTS5) и на MS SQL (нужен полнотекстовый каталог) режим молча остаётся `'like'`:
 * один и тот же код обычно работает на SQLite в разработке и на PostgreSQL в продакшене,
 * и падать на этом различии он не должен. В MySQL колонка обязана входить в индекс `FULLTEXT`,
 * иначе СУБД отвергнет запрос — это видно сразу и чинится миграцией.
 */
import type { DataSource, EntityMetadata, ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import { Brackets } from 'typeorm';

import { normalizeDialect } from '../../dialect';
import { ODataInvalidQueryError } from '../../errors';
import type { QueryParams } from '../../types';
import { parseSearch, type SearchNode } from '../parseSearch';
import { buildRelationSource } from '../relationSource';
import { createEscape } from '../sqlIdentifier';

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

/** Символ экранирования шаблона `LIKE`; см. шапку файла. */
const LIKE_ESCAPE = '!';

/**
 * Одна цель поиска: выражение колонки и способ подставить его в условие.
 *
 * @property expression - готовое выражение колонки в SQL, уже с алиасом.
 * @property kind - как сравнивать: по подстроке или на равенство.
 * @property wrap - обёртка вокруг условия. Для колонки корня — тождественная, для колонки
 *   связи — цепочка `EXISTS (SELECT 1 FROM … WHERE … AND <условие>)`.
 */
interface SearchTarget {
  expression: string;
  kind: 'text' | 'number';
  wrap: (condition: string) => string;
}

/** К какому виду поиска пригодна колонка; `undefined` — ни к какому. */
function columnKind(column: EntityMetadata['columns'][number]): 'text' | 'number' | undefined {
  // Тип колонки в метаданных бывает и строкой ('varchar'), и конструктором (String, Number) —
  // для SQLite TypeORM выводит именно конструкторы. Приводим оба варианта к строке.
  const type = typeof column.type === 'function' ? column.type.name : column.type;
  const typeLower = type?.toLowerCase();

  if (searchableTextColumnTypes.includes(typeLower as SearchableTextColumnType)) {
    return 'text';
  }

  if (searchableNumberColumnTypes.includes(typeLower as SearchableNumberColumnType)) {
    return 'number';
  }

  return undefined;
}

/**
 * Разрешает путь `'author/name'` в цель поиска.
 *
 * @throws {ODataInvalidQueryError} путь не существует либо ведёт к колонке, по которой
 *   искать нельзя (дата, UUID, JSON). Ошибка, а не молчаливый пропуск: указанное в настройках
 *   поле, по которому не ищут, — это опечатка разработчика, и её лучше увидеть сразу.
 */
function resolveField(
  connection: DataSource,
  metadata: EntityMetadata,
  rootAlias: string,
  path: string,
  index: number
): SearchTarget {
  const escape = createEscape(connection);
  const segments = path.split('/');
  const field = segments.pop() as string;

  let current = metadata;
  let alias = rootAlias;
  let wrap: (condition: string) => string = (condition) => condition;

  if (segments.length > 0) {
    const childAlias = `${rootAlias}__s${index}`;
    const source = buildRelationSource(connection, metadata, segments, rootAlias, childAlias);

    if (!source) {
      throw new ODataInvalidQueryError('$search', `unknown search field: ${path}`);
    }

    current = source.metadata;
    alias = childAlias;
    wrap = (condition) =>
      `EXISTS (SELECT 1 FROM ${source.from} WHERE ${source.where} AND ${condition})`;
  }

  const column = current.columns.find((candidate) => candidate.propertyPath === field);

  if (!column) {
    throw new ODataInvalidQueryError('$search', `unknown search field: ${path}`);
  }

  const kind = columnKind(column);

  if (!kind) {
    throw new ODataInvalidQueryError('$search', `field is not searchable: ${path}`);
  }

  return { expression: `${escape(alias)}.${escape(column.databaseName)}`, kind, wrap };
}

/** Скалярные колонки корневой сущности — набор по умолчанию. */
function rootTargets(
  connection: DataSource,
  metadata: EntityMetadata,
  alias: string
): SearchTarget[] {
  const escape = createEscape(connection);
  const targets: SearchTarget[] = [];

  for (const column of metadata.columns) {
    // Колонки связей (внешние ключи) пропускаем: их значения клиенту не показываются,
    // а поиск по ним даёт неожиданные совпадения по идентификаторам.
    if (column.relationMetadata) {
      continue;
    }

    const kind = columnKind(column);

    if (!kind) {
      continue;
    }

    targets.push({
      expression: `${escape(alias)}.${escape(column.databaseName)}`,
      kind,
      wrap: (condition) => condition,
    });
  }

  return targets;
}

/** Экранирует спецсимволы шаблона `LIKE`, чтобы `%` и `_` искались буквально. */
function escapeLikePattern(value: string): string {
  return value.replace(/[%_!]/g, (char) => `${LIKE_ESCAPE}${char}`);
}

/** Как сравнивать текст: подстрокой или полнотекстовым поиском СУБД. */
export type SearchMode = 'like' | 'fulltext';

/**
 * Имя конфигурации полнотекстового поиска PostgreSQL — подставляется в SQL как есть,
 * поэтому проверяется по строгому шаблону: параметром его передать нельзя, а конкатенация
 * пользовательской строки в SQL без проверки была бы инъекцией.
 */
const FULLTEXT_LANGUAGE = /^[a-z_][a-z0-9_]*$/;

/** Опции поиска. */
export interface ProcessSearchOptions {
  /**
   * Поля, по которым идёт поиск: пути свойств от корня (`'name'`, `'author/name'`).
   *
   * Не заданы — берутся все скалярные колонки корневой сущности.
   */
  fields?: readonly string[];

  /** Способ сравнения текста. @defaultValue `'like'` */
  mode?: SearchMode;

  /** Конфигурация полнотекстового поиска PostgreSQL. @defaultValue `'simple'` */
  language?: string;
}

/**
 * Добавляет к `queryBuilder` условия поиска по выражению `$search`.
 *
 * @param queryBuilder - построитель, который мутируется на месте (функция ничего не возвращает).
 * @param metadata - метаданные корневой сущности (список колонок, типов и связей).
 * @param $search - выражение поиска; пустое — ранний выход.
 * @param alias - SQL-алиас корневой таблицы в запросе.
 * @param options - какие поля участвуют в поиске.
 *
 * @throws {ODataInvalidQueryError} выражение синтаксически неверно либо в `fields` указано
 *   несуществующее или непригодное для поиска поле.
 *
 * @example
 * // $search=ada OR "grace hopper"
 * //   AND (
 * //     ("User"."name" IS NOT NULL AND LOWER("User"."name") LIKE :searchText0 ESCAPE '!')
 * //     OR ("User"."name" IS NOT NULL AND LOWER("User"."name") LIKE :searchText1 ESCAPE '!')
 * //   )
 * // с параметрами { searchText0: '%ada%', searchText1: '%grace hopper%' }
 */
export const processSearch = <T extends ObjectLiteral = ObjectLiteral>(
  queryBuilder: SelectQueryBuilder<T>,
  metadata: EntityMetadata,
  $search: Required<QueryParams>['$search'],
  alias: string,
  options: ProcessSearchOptions = {}
) => {
  const expression = parseSearch($search ?? '');

  if (!expression) {
    return;
  }

  const connection = queryBuilder.connection;
  const dialect = normalizeDialect(connection.options.type);
  const language = options.language ?? 'simple';

  if (!FULLTEXT_LANGUAGE.test(language)) {
    throw new ODataInvalidQueryError('$search', `invalid full-text language: ${language}`);
  }

  /**
   * Полнотекстовый поиск используется, только если о нём попросили И СУБД его умеет
   * на обычных колонках. SQLite (FTS5 — отдельная виртуальная таблица) и MS SQL
   * (нужен полнотекстовый каталог) сюда не попадают: там остаётся `LIKE`.
   */
  const fulltext = options.mode === 'fulltext' && (dialect === 'postgres' || dialect === 'mysql');

  const targets = options.fields
    ? options.fields.map((path, index) => resolveField(connection, metadata, alias, path, index))
    : rootTargets(connection, metadata, alias);

  // Подходящих колонок нет — не добавляем ничего. Альтернатива («не нашли — не вернём ничего»)
  // сломала бы запросы к сущностям без текстовых полей, а так $search просто игнорируется.
  if (targets.length === 0) {
    return;
  }

  const parameters: Record<string, string | number> = {};
  let termIndex = 0;

  /**
   * Сравнение текстовой колонки с искомым значением.
   *
   * `LIKE` ищет подстроку — так работает режим по умолчанию. Полнотекстовый поиск ищет слова
   * целиком, зато пользуется индексом: `to_tsvector @@ plainto_tsquery` в PostgreSQL,
   * `MATCH … AGAINST` в MySQL. Для фразы берутся их «фразовые» варианты, где важен ещё
   * и порядок слов.
   */
  function match(target: SearchTarget, parameterName: string, phrase: boolean): string {
    if (fulltext && dialect === 'postgres') {
      const toQuery = phrase ? 'phraseto_tsquery' : 'plainto_tsquery';

      return (
        `to_tsvector('${language}', ${target.expression}) @@ ` +
        `${toQuery}('${language}', :${parameterName})`
      );
    }

    if (fulltext && dialect === 'mysql') {
      return `MATCH(${target.expression}) AGAINST(:${parameterName} IN BOOLEAN MODE)`;
    }

    return `LOWER(${target.expression}) LIKE :${parameterName} ESCAPE '${LIKE_ESCAPE}'`;
  }

  /** Условие для одного слова или фразы: совпадение хотя бы по одной цели поиска. */
  function compileTerm(value: string, phrase: boolean): string {
    const index = termIndex++;
    const conditions: string[] = [];

    const textName = `searchText${index}`;
    const numberName = `searchNumber${index}`;

    // Значение приводится к нижнему регистру заранее, чтобы LOWER(:param) не зависел
    // от локали сервера БД.
    if (fulltext) {
      // MySQL: значение оборачивается в кавычки, чтобы `-слово` и `*` не были поняты как
      // операторы булева режима — структуру выражения задаёт разобранное дерево, а не строка.
      // PostgreSQL: `plainto_tsquery` и `phraseto_tsquery` операторов и не разбирают.
      parameters[textName] = dialect === 'mysql' ? `"${value.replace(/"/g, ' ')}"` : value;
    } else {
      parameters[textName] = `%${escapeLikePattern(value.toLowerCase())}%`;
    }

    // Число ищется на точное равенство. Именно `Number`, а не `parseInt`: тот отрезает
    // хвост (`parseInt('123a') === 123`) и дал бы ложные совпадения.
    const numericValue = Number(value);
    const numeric = value.trim() !== '' && !Number.isNaN(numericValue);

    if (numeric) {
      parameters[numberName] = numericValue;
    }

    for (const target of targets) {
      if (target.kind === 'text') {
        conditions.push(
          target.wrap(`(${target.expression} IS NOT NULL AND ${match(target, textName, phrase)})`)
        );
      } else if (numeric) {
        conditions.push(
          target.wrap(
            `(${target.expression} IS NOT NULL AND ${target.expression} = :${numberName})`
          )
        );
      }
    }

    // Слово не сравнимо ни с одной целью (например ищем текст, а все поля числовые) —
    // такой терм не совпадает ни с чем.
    if (conditions.length === 0) {
      return '1 = 0';
    }

    return `(${conditions.join(' OR ')})`;
  }

  function compile(node: SearchNode): string {
    switch (node.type) {
      case 'term':
        return compileTerm(node.value, node.phrase);
      case 'not':
        return `NOT ${compile(node.operand)}`;
      case 'and':
        return `(${compile(node.left)} AND ${compile(node.right)})`;
      case 'or':
        return `(${compile(node.left)} OR ${compile(node.right)})`;
    }
  }

  const condition = compile(expression);

  // Скобки обязательны: без них OR внутри условия «растёк» бы по остальным условиям запроса,
  // и $filter перестал бы ограничивать выдачу.
  queryBuilder.andWhere(
    new Brackets((qb) => {
      qb.where(condition);
    }),
    parameters
  );
};
