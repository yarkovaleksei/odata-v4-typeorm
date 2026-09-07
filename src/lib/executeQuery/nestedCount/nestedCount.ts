/**
 * @file Счётчик связанных строк для `$count` внутри `$expand`.
 *
 * ЧТО ЭТО. `$expand=books($count=true)` просит не только сами книги, но и их общее число
 * у каждого автора. По OData JSON (раздел 12) число приходит аннотацией рядом с самой
 * связью: `"books@odata.count": 5`. Форма связи при этом не меняется — `books` остаётся
 * массивом, и код, который его перебирает, ничего не замечает.
 *
 * ПОЧЕМУ КОРРЕЛИРОВАННЫЙ ПОДЗАПРОС, А НЕ ОКНО И НЕ ОТДЕЛЬНЫЙ ЗАПРОС. Счётчик обязан
 * игнорировать вложенные `$top` / `$skip` — ровно как корневой `count` игнорирует `take`
 * и `skip`. Оконная функция для этого не годится: страницу связи вырезает такое же окно
 * в условии соединения (`nestedPageCondition`), и считать пришлось бы до среза, то есть
 * в другом окне и другом подзапросе. Отдельный запрос с `GROUP BY` потребовал бы второго
 * обращения к базе на каждую связь. Скалярный подзапрос в `SELECT` не зависит ни от среза,
 * ни от соединения: он считает строки связи заново, с одним лишь вложенным `$filter`.
 *
 * ПОЧЕМУ ГЛУБИНА ОДИН УРОВЕНЬ. Значения подзапросов приходят в «сыром» результате и
 * раскладываются по сущностям корня по первичному ключу — тем же способом, что и `$compute`
 * (см. `selectRawExtras`). Для связи связи пришлось бы сопоставлять строки с элементами
 * каждой коллекции по отдельности, и ровно поэтому `$compute` в `$select` тоже сделан
 * только для корня. Запрос глубже отвергается ошибкой, а не выполняется без счётчика:
 * молча потерянная опция — это ответ, не соответствующий запросу.
 */
import type { DataSource, EntityMetadata } from 'typeorm';

import { ODataInvalidQueryError, ODataUnsupportedError } from '../../errors';
import type { TypeOrmVisitor } from '../../TypeOrmVisitor';
import { buildRelationSource } from '../relationSource';

/**
 * Суффикс имени свойства со счётчиком.
 *
 * Имя из спецификации OData JSON, а не придуманное (`booksCount`): во-первых, его ждут
 * клиенты, во-вторых, оно не может столкнуться со свойством сущности — символа `@`
 * в имени свойства TypeORM не бывает.
 */
export const NESTED_COUNT_ANNOTATION = '@odata.count';

/** Префикс псевдонимов, под которыми счётчики приходят в «сыром» результате. */
const RAW_ALIAS_PREFIX = 'odata_nested_count_';

/** Один счётчик: что посчитать, под каким псевдонимом забрать и куда положить. */
export interface NestedCount {
  /** Имя свойства в ответе: `books@odata.count`. */
  property: string;
  /** Псевдоним колонки в «сыром» результате. Без `@`: это имя уходит в SQL. */
  rawAlias: string;
  /** Скалярный подзапрос `(SELECT COUNT(*) …)`. */
  sql: string;
}

/**
 * Отвергает `$count` глубже первого уровня `$expand`.
 *
 * @param includes - посетители уровня, который уже считается вложенным.
 * @param path - путь связей от корня; идёт в текст ошибки, чтобы было видно, где именно.
 *
 * @throws {ODataUnsupportedError} если `$count` встретился ниже первого уровня.
 */
function assertNoDeepNestedCount(includes: readonly TypeOrmVisitor[], path: string[]): void {
  for (const include of includes) {
    const current = [...path, include.navigationProperty];

    if (include.inlinecount) {
      throw new ODataUnsupportedError('$count below the first level of $expand', current.join('/'));
    }

    assertNoDeepNestedCount(include.includes, current);
  }
}

/**
 * Собирает подзапросы-счётчики по связям корня, у которых запрошен `$count`.
 *
 * Алиас подзапроса намеренно совпадает с алиасом соединения (`Author_books`): вложенный
 * `$filter` посетитель уже скомпилировал с этим именем, и другое имя пришлось бы
 * переписывать в готовой строке SQL. Внутри подзапроса это имя перекрывает внешнее
 * соединение, что и требуется: считать нужно все строки связи, а не те, что остались
 * после среза страницы.
 *
 * @param connection - подключение: экранирование идентификаторов и имена таблиц.
 * @param metadata - метаданные корневой сущности.
 * @param alias - SQL-алиас корня: к нему подзапрос коррелирует.
 * @param visitor - корневой посетитель; берутся его `includes`.
 * @returns счётчики в порядке появления связей в `$expand`; пустой массив, если `$count`
 *   внутри `$expand` не запрашивали.
 *
 * @throws {ODataInvalidQueryError} `$count` запрошен у связи «к одному»: считать там нечего.
 * @throws {ODataUnsupportedError} `$count` глубже первого уровня либо метаданных связи
 *   не хватает, чтобы построить подзапрос.
 */
export function collectNestedCounts(
  connection: DataSource,
  metadata: EntityMetadata,
  alias: string,
  visitor: TypeOrmVisitor
): NestedCount[] {
  const counts: NestedCount[] = [];

  for (const include of visitor.includes) {
    assertNoDeepNestedCount(include.includes, [include.navigationProperty]);

    if (!include.inlinecount) {
      continue;
    }

    const relation = metadata.relations.find(
      (candidate) => candidate.propertyPath === include.navigationProperty
    );

    // Неизвестная связь — не наша забота: про неё понятнее сообщит сам TypeORM,
    // когда дойдёт до `leftJoin`. Так же поступает и `processIncludes`.
    if (!relation) {
      continue;
    }

    if (!relation.isOneToMany && !relation.isManyToMany) {
      throw new ODataInvalidQueryError(
        '$count',
        `navigation property is not a collection: ${include.navigationProperty}`
      );
    }

    const source = buildRelationSource(
      connection,
      metadata,
      [include.navigationProperty],
      alias,
      include.alias
    );

    if (!source) {
      throw new ODataUnsupportedError('$count for this relation', include.navigationProperty);
    }

    counts.push({
      property: `${include.navigationProperty}${NESTED_COUNT_ANNOTATION}`,
      rawAlias: `${RAW_ALIAS_PREFIX}${counts.length}`,
      // Вложенный `$filter` учитывается, вложенные `$top` / `$skip` — нет: счётчик отвечает
      // на вопрос «сколько всего подходит», а не «сколько пришло на этой странице».
      // У связи без `$filter` посетитель отдаёт `1 = 1` — условие, ломать которым нечего.
      sql: `(SELECT COUNT(*) FROM ${source.from} WHERE ${source.where} AND (${include.where}))`,
    });
  }

  return counts;
}
