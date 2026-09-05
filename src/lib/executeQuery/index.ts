/**
 * @file Баррель слоя выполнения запросов.
 *
 * Наружу отдаются и точки входа (`executeQuery`, `executeQueryByQueryBuilder`), и внутренние шаги
 * конвейера (`mapToObject`, `processIncludes`, `processSearch`, `queryToOdataString`).
 * Последние экспортируются потому, что баррель реэкспортируется целиком из `src/lib/index.ts`;
 * рассчитывать на их стабильность между минорными версиями не стоит.
 */
export * from './executeQuery';
export * from './executeQueryByQueryBuilder';
export * from './mapToObject';
export * from './processIncludes';
export * from './processSearch';
export * from './queryToOdataString';
export * from './types';
