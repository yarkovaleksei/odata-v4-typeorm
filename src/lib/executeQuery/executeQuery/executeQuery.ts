/**
 * @file Унифицированная точка входа библиотеки: принимает либо `Repository`, либо готовый
 * `SelectQueryBuilder`, нормализует к QueryBuilder и делегирует в `executeQueryByQueryBuilder`.
 *
 * Это тонкая обёртка — вся логика OData живёт в `executeQueryByQueryBuilder`.
 */
import type { ObjectLiteral, Repository, SelectQueryBuilder } from 'typeorm';

import type { QueryParams } from '../../types';
import { executeQueryByQueryBuilder } from '../executeQueryByQueryBuilder';
import type { ExecuteQueryOptions } from '../types';

/**
 * Выполняет OData-параметры против TypeORM.
 *
 * @param repositoryOrQueryBuilder - если передан `Repository`, создаётся `createQueryBuilder(alias)`;
 *   если `SelectQueryBuilder` — используется как есть (можно заранее добавить свои условия,
 *   они сохранятся: OData-условия добавляются через `andWhere`).
 * @param query - объект параметров (`$filter`, `$top`, …), обычно напрямую `req.query`.
 * @param options - `alias` корневой сущности, ограничение `maxTop` и белые списки
 *   `allowedFields` / `allowedExpands`. Для ветки с `Repository` алиас практически обязателен:
 *   `createQueryBuilder(undefined)` даст безымянный алиас. Для `SelectQueryBuilder` можно
 *   не задавать — подставится `expressionMap.mainAlias`.
 * @returns массив сущностей; `{ items, count }` — только если передан `$count=true`.
 *
 * @example
 * // Репозиторий целиком
 * const data = await executeQuery(dataSource.getRepository(User), req.query, { alias: 'User' });
 *
 * @example
 * // QueryBuilder с предустановленным ограничением доступа. Алиас произвольный.
 * const qb = dataSource.getRepository(User)
 *   .createQueryBuilder('u')
 *   .where('u.tenantId = :tenantId', { tenantId });
 *
 * const data = await executeQuery(qb, req.query);
 *
 * @example
 * // Публичный API: ограничиваем страницу и перечень доступных полей и связей
 * const data = await executeQuery(repository, req.query, {
 *   alias: 'User',
 *   maxTop: 100,
 *   allowedFields: ['id', 'name', 'posts/title'],
 *   allowedExpands: ['posts'],
 * });
 */
export const executeQuery = async <T extends ObjectLiteral = ObjectLiteral>(
  repositoryOrQueryBuilder: Repository<T> | SelectQueryBuilder<T>,
  query: QueryParams,
  options: ExecuteQueryOptions = {}
) => {
  const alias = options?.alias ?? '';
  let queryBuilder: SelectQueryBuilder<T> = repositoryOrQueryBuilder as SelectQueryBuilder<T>;

  // Различение типов в рантайме: TypeORM не даёт для этого публичного предиката, а `instanceof`
  // ненадёжен при нескольких копиях typeorm в node_modules. `expressionMap` есть у любого
  // QueryBuilder и отсутствует у Repository — этого признака достаточно.
  if (typeof (repositoryOrQueryBuilder as SelectQueryBuilder<T>).expressionMap === 'undefined') {
    queryBuilder = (repositoryOrQueryBuilder as Repository<T>).createQueryBuilder(alias);
  }

  // Опции пробрасываются целиком: maxTop и белые списки нужны следующему слою как есть.
  const result = await executeQueryByQueryBuilder<T>(queryBuilder, query, {
    ...options,
    alias,
  });

  return result;
};
