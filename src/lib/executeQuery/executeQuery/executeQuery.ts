/**
 * Унифицированная точка входа: принимает либо `Repository`, либо готовый `SelectQueryBuilder`,
 * нормализует в QueryBuilder и делегирует в `executeQueryByQueryBuilder`.
 */
import type { ObjectLiteral, Repository, SelectQueryBuilder } from 'typeorm';

import type { QueryParams } from '../../types';
import { executeQueryByQueryBuilder } from '../executeQueryByQueryBuilder';
import type { ExecuteQueryOptions } from '../types';

/**
 * Выполняет OData-параметры против TypeORM.
 *
 * @param repositoryOrQueryBuilder - если передан `Repository`, создаётся `createQueryBuilder(alias)`;
 *   если `SelectQueryBuilder` — используется как есть (можно заранее добавить свои условия).
 * @param query - объект параметров (`$filter`, `$top`, …).
 * @param options - `alias` обязателен для ветки с `Repository`; для QB может быть пустым и тогда подставится `mainAlias`.
 */
export const executeQuery = async <T extends ObjectLiteral = ObjectLiteral>(
  repositoryOrQueryBuilder: Repository<T> | SelectQueryBuilder<T>,
  query: QueryParams,
  options: ExecuteQueryOptions = {}
) => {
  const localOptions: Required<ExecuteQueryOptions> = {
    alias: '',
    ...(options ?? {}),
  };

  const { alias } = localOptions;
  let queryBuilder: SelectQueryBuilder<T> = repositoryOrQueryBuilder as SelectQueryBuilder<T>;

  // У SelectQueryBuilder всегда есть expressionMap; у Repository — нет. Так отличаем тип в рантайме.
  if (typeof (repositoryOrQueryBuilder as SelectQueryBuilder<T>).expressionMap === 'undefined') {
    queryBuilder = (repositoryOrQueryBuilder as Repository<T>).createQueryBuilder(alias);
  }

  const result = await executeQueryByQueryBuilder<T>(queryBuilder, query, {
    alias,
  });

  return result;
};
