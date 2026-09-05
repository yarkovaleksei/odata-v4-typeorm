/**
 * @file Общие типы для входящих HTTP/query параметров и настроек генерации SQL.
 *
 * Значения приходят в основном как строки (как из `req.query` в Express); часть полей
 * перед выполнением запроса приводится к числам/булевым типам (см. `parseQueryParams`).
 */
import { type SqlOptions as BaseSqlOptions } from 'odata-v4-sql/lib';

/**
 * Расширение опций `odata-v4-sql`.
 *
 * Базовый тип даёт `type` (диалект SQL) и `useParameters` (плейсхолдеры вместо инлайна литералов);
 * здесь добавляется обязательный `alias` — SQL-префикс колонок в WHERE/SELECT/ORDER BY.
 *
 * Значение `alias` служит сразу двум целям, и это важно помнить: помимо префикса колонок оно же
 * используется как ключ поиска метаданных сущности в `executeQueryByQueryBuilder`, поэтому должно
 * совпадать с именем класса сущности либо именем её таблицы.
 */
export interface SqlOptions extends BaseSqlOptions {
  alias: string;
}

/**
 * Параметры OData V4 в «сыром» виде, как их обычно передают в query string.
 * Ключи совпадают с именами системных query options OData (`$filter`, `$top`, …).
 *
 * Все поля объявлены строками, потому что тип описывает вход до нормализации — ровно то,
 * что кладёт в `req.query` Express. Числовые и булевы значения появляются только
 * в {@link ParsedQueryParams}.
 *
 * Системные опции OData, которых здесь нет и которые библиотека не поддерживает:
 * `$apply`, `$compute`, `$format`, `$levels`, `$skiptoken`, `$deltatoken`, `$id`, `$schemaversion`.
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
 * Нормализованные параметры после `parseQueryParams`.
 *
 * `$top` / `$skip` / `$count` строго типизированы и всегда определены (не `undefined`), потому что
 * ими управляет логика пагинации. Остальные опции остаются строками: их значение — это выражения
 * на языке OData, которые всё равно поедут обратно в парсер через `queryToOdataString`.
 *
 * `$search` намеренно опциональный: `undefined` здесь означает «поиск не применять»,
 * и `executeQueryByQueryBuilder` отделяет его до склейки OData-строки.
 */
export type ParsedQueryParams = Pick<
  QueryParams,
  '$search' | '$filter' | '$orderby' | '$select' | '$expand'
> & {
  $top: number;
  $skip: number;
  $count: boolean;
};
