/**
 * @file Публичный API пакета `odata-v4-typeorm-improved`.
 *
 * Всё, что реэкспортировано отсюда, считается частью контракта и не меняется без смены мажорной
 * версии. Внутренние помощники (`mapToObject`, `processIncludes`, `processSearch`,
 * `queryToOdataString`, `parseQueryParams`) тоже видны наружу — исторически, из-за реэкспорта
 * барреля `executeQuery` целиком.
 *
 * Три уровня использования, от высокого к низкому:
 * 1. `ODataQueryMiddleware` — готовый обработчик Express, сам отправляет ответ;
 * 2. `executeQuery` / `executeQueryByQueryBuilder` — выполнение поверх TypeORM, ответ формирует
 *    вызывающий код;
 * 3. `createQuery` / `createFilter` / `TypeOrmVisitor` — только компиляция OData в SQL-фрагменты,
 *    без обращения к БД. Подходит для «сырых» драйверов.
 */
export * from './TypeOrmVisitor';
export * from './createFilter';
export * from './createQuery';
export * from './executeQuery';
export * from './ODataQueryMiddleware';
export * from './executeQuery/executeQueryByQueryBuilder/parseQueryParams';
export * from './types';
