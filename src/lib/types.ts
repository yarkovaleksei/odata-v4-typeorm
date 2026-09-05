/**
 * Общие типы для входящих HTTP/query параметров и настроек генерации SQL.
 *
 * Значения приходят в основном как строки (как из `req.query` в Express); часть полей
 * перед выполнением запроса приводится к числам/булевым типам (см. `parseQueryParams`).
 */
import { type SqlOptions as BaseSqlOptions } from 'odata-v4-sql/lib';

/**
 * Расширение опций `odata-v4-sql`: задаёт SQL-алиас корневой сущности (префикс колонок в WHERE/SELECT).
 * Используется посетителем `TypeOrmVisitor` при разборе OData AST.
 */
export interface SqlOptions extends BaseSqlOptions {
  alias: string;
}

/**
 * Параметры OData V4 в «сыром» виде, как их обычно передают в query string.
 * Ключи совпадают с именами системных query options OData (`$filter`, `$top`, …).
 */
export interface QueryParams {
  $search?: string;
  $filter?: string;
  $orderby?: string;
  $select?: string;
  $expand?: string;
  $top?: string;
  $skip?: string;
  $count?: string;
}

/**
 * Нормализованные параметры после парсинга: пагинация и флаг `$count` — строго типизированы,
 * строковые опции (`$filter`, `$expand`, …) остаются строками для дальнейшей склейки в OData-строку.
 */
export type ParsedQueryParams = Pick<
  QueryParams,
  '$search' | '$filter' | '$orderby' | '$select' | '$expand'
> & {
  $top: number;
  $skip: number;
  $count: boolean;
};
