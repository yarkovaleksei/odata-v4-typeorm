/**
 * @file Типы, специфичные для слоя `executeQuery`: опции вызова и форма ответа при `$count=true`.
 */
import type { ObjectLiteral } from 'typeorm';

/** Опции выполнения запроса. */
export interface ExecuteQueryOptions {
  /**
   * SQL-алиас корневой сущности.
   *
   * Обязан совпадать с именем класса сущности или именем её таблицы — по нему ищутся метаданные
   * (`connection.getMetadata(alias)`). Произвольное сокращение (`'u'`) приведёт к
   * `EntityMetadataNotFoundError`.
   *
   * Для `SelectQueryBuilder` можно не задавать: подставится `expressionMap.mainAlias.name`.
   * Для `Repository` — задавайте всегда.
   */
  alias?: string;
}

/**
 * Ответ при включённом `$count`: страница данных и общее число строк по текущим фильтрам
 * (без учёта `$top` / `$skip`).
 *
 * Это форма ответа ПО УМОЛЧАНИЮ: `$count` включён, если клиент не передал `$count=false`.
 * Поэтому возвращаемый тип `executeQuery` — объединение `T[] | GetManyResponse<T>`,
 * и на стороне вызова его нужно сузить.
 *
 * @example
 * const result = await executeQuery(repo, req.query, { alias: 'User' });
 * const items = Array.isArray(result) ? result : result.items;
 */
export interface GetManyResponse<T extends ObjectLiteral> {
  items: T[];
  count: number;
}
