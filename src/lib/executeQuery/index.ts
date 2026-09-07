/**
 * @file Баррель слоя выполнения запросов.
 *
 * Наружу отдаются и точки входа (`executeQuery`, `executeQueryByQueryBuilder`), и внутренние шаги
 * конвейера (`applyNestedPagination`, `mapToObject`, `parseSearch`, `processIncludes`, `processSearch`,
 * `queryToOdataString`).
 * Последние экспортируются потому, что баррель реэкспортируется целиком из `src/lib/index.ts`;
 * рассчитывать на их стабильность между минорными версиями не стоит.
 */
export * from './applyNestedPagination';
export * from './executeQuery';
export * from './executeQueryByQueryBuilder';
export * from './mapToObject';
export * from './parseSearch';
export * from './processIncludes';
export * from './processSearch';
export * from './queryToOdataString';
export * from './types';
