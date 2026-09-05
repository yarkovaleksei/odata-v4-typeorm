/**
 * @file Общие типы для входящих HTTP/query параметров и настроек генерации SQL.
 *
 * Значения приходят в основном как строки (как из `req.query` в Express); часть полей
 * перед выполнением запроса приводится к числам/булевым типам (см. `parseQueryParams`).
 */
import { type SqlOptions as BaseSqlOptions } from 'odata-v4-sql/lib';

/**
 * Диалекты SQL, для которых библиотека умеет подбирать реализацию функций OData.
 *
 * Это НЕ то же самое, что `SQLLang` из `odata-v4-sql`: тот отвечает только за формат
 * плейсхолдеров и жёстко зафиксирован на `Oracle` (см. заголовок `TypeOrmVisitor`).
 * Здесь же выбирается конкретная SQL-функция — `LENGTH` против `LEN`, `EXTRACT` против
 * `strftime` и так далее.
 *
 * `'ansi'` — запасной вариант для незнакомого драйвера: берутся наиболее переносимые формы.
 */
export type SqlDialect = 'postgres' | 'mysql' | 'sqlite' | 'mssql' | 'oracle' | 'ansi';

/**
 * Расширение опций `odata-v4-sql`.
 *
 * Базовый тип даёт `type` (формат плейсхолдеров) и `useParameters` (плейсхолдеры вместо
 * инлайна литералов); здесь добавляются `alias` и `dialect`.
 *
 * Значение `alias` служит сразу двум целям, и это важно помнить: помимо префикса колонок оно же
 * используется как ключ поиска метаданных сущности в `executeQueryByQueryBuilder`, поэтому должно
 * совпадать с именем класса сущности либо именем её таблицы.
 */
export interface SqlOptions extends BaseSqlOptions {
  alias: string;

  /**
   * Целевая СУБД. Определяет, какие SQL-функции подставлять для функций OData.
   *
   * Принимается как значение {@link SqlDialect}, так и «сырой» `type` из настроек TypeORM
   * (`'better-sqlite3'`, `'mariadb'`, `'aurora-postgres'`, …) — незнакомые значения
   * приводятся к `'ansi'`.
   *
   * `executeQuery` подставляет его автоматически из подключения; задавать вручную нужно
   * только при прямом вызове `createQuery` / `createFilter`.
   *
   * @defaultValue `'ansi'`
   */
  dialect?: SqlDialect | string;
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
  /**
   * Размер страницы. `undefined` означает «клиент не задавал `$top`» и трактуется как
   * «лимита нет»; `0` — что клиент запросил ровно ноль строк, и это валидный запрос
   * по OData v4 (раздел 11.2.6.4), а не синоним отсутствия лимита.
   */
  $top?: number;
  $skip: number;
  /**
   * Нужен ли счётчик. Отсутствующий в запросе `$count` даёт `false` — так требует
   * OData v4 (раздел 11.2.5.5), и от этого зависит форма ответа: массив против
   * `{ items, count }`.
   */
  $count: boolean;
};
