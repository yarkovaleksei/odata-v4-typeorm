/**
 * Типы, специфичные для слоя `executeQuery`: опции вызова и форма ответа при `$count=true`.
 */
import type { ObjectLiteral } from 'typeorm';

/** Опции при выполнении через QueryBuilder; `alias` должен совпадать с корневым алиасом в TypeORM. */
export interface ExecuteQueryOptions {
  alias?: string;
}

/**
 * Ответ при запросе с `$count=true`: одновременно страница данных и общее число строк по текущим фильтрам.
 */
export interface GetManyResponse<T extends ObjectLiteral> {
  items: T[];
  count: number;
}
