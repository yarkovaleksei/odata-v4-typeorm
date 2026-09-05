/**
 * Основной конвейер выполнения OData поверх `SelectQueryBuilder`.
 *
 * 1. `parseQueryParams` — нормализация типов и выделение `$search` (он обрабатывается отдельно, не через OData-строку).
 * 2. `queryToOdataString` — остальные `$...` поля склеиваются в строку для парсера.
 * 3. `createQuery` — AST → объект `TypeOrmVisitor` с SQL-фрагментами и деревом `includes` для `$expand`.
 * 4. По метаданным сущности формируется список колонок SELECT, накладываются WHERE/параметры, JOIN-ы,
 *    сортировка, затем опционально `$search`, пагинация и либо `getMany`, либо `getManyAndCount`.
 */
import type { ObjectLiteral, SelectQueryBuilder } from 'typeorm';

import { createQuery } from '../../createQuery';
import type { QueryParams } from '../../types';
import { mapToObject } from '../mapToObject';
import { processIncludes } from '../processIncludes';
import { processSearch } from '../processSearch';
import { queryToOdataString } from '../queryToOdataString';
import type { ExecuteQueryOptions, GetManyResponse } from '../types';
import { parseQueryParams } from './parseQueryParams';

/**
 * Выполняет запрос с помощью QueryBuilder с поддержкой OData-подобных параметров.
 *
 * @param inputQueryBuilder - исходный QueryBuilder (может быть уже с условиями)
 * @param query - объект параметров запроса (например, { $search: 'text', $top: 10 })
 * @param options - опции выполнения (alias корневой сущности)
 * @returns результат запроса: массив сущностей или объект { items, count } при $count=true
 */
export const executeQueryByQueryBuilder = async <T extends ObjectLiteral = ObjectLiteral>(
  inputQueryBuilder: SelectQueryBuilder<T>,
  query: QueryParams,
  options: ExecuteQueryOptions = {}
): Promise<T[] | GetManyResponse<T>> => {
  // Извлекаем $search, остальные параметры идут на формирование OData
  const { $search, ...parsedQueryWithoutSearch } = parseQueryParams(query);

  // Нормализуем опции: alias может быть передан или взят из mainAlias
  const localOptions: Required<ExecuteQueryOptions> = {
    alias: '',
    ...(options ?? {}),
  };
  const alias = localOptions.alias || (inputQueryBuilder.expressionMap.mainAlias?.name ?? '');

  // Преобразуем параметры в OData-строку и затем в объект odataQuery
  const odataString = queryToOdataString(parsedQueryWithoutSearch);
  const odataQuery = createQuery(odataString, { alias });

  // Метаданные сущности для получения списка колонок и отношений
  const metadata = inputQueryBuilder.connection.getMetadata(alias);

  let queryBuilder = inputQueryBuilder;
  let rootSelect: string[];

  // Определяем, какие поля корневой сущности выбирать
  if (Object.keys(odataQuery).length === 0 || odataQuery.select === '*') {
    // Если select не указан или равен '*', берём все не виртуальные колонки
    rootSelect = metadata.nonVirtualColumns.map((x) => `${alias}.${x.propertyPath}`);
  } else {
    // Иначе используем явно указанные поля (без добавления алиаса, предполагается, что они уже его содержат)
    rootSelect = odataQuery.select.split(',').map((x: string) => x.trim());
  }

  // Применяем SELECT
  queryBuilder = queryBuilder.select(rootSelect);

  // Применяем фильтрацию и параметры
  queryBuilder = queryBuilder
    .andWhere(odataQuery.where)
    .setParameters(mapToObject(odataQuery.parameters));

  // Обрабатываем вложенные связи ($expand)
  queryBuilder = processIncludes<T>(queryBuilder, odataQuery, alias, metadata);

  // Обрабатываем сортировку ($orderby), если она не равна '1' (условное обозначение "без сортировки")
  if (odataQuery.orderby && odataQuery.orderby !== '1') {
    const orders: string[] = odataQuery.orderby.split(',').map((i: string) => i.trim());

    orders.forEach((orderItem) => {
      const [field, order] = orderItem.split(' ');

      queryBuilder = queryBuilder.addOrderBy(field, order as 'ASC' | 'DESC');
    });
  }

  // Обрабатываем поиск по $search (регистронезависимый поиск подстроки в текстовых/числовых колонках)
  if ($search) {
    processSearch<T>(queryBuilder, metadata, $search, alias);
  }

  // Пагинация: пропуск записей ($skip)
  queryBuilder = queryBuilder.skip(parsedQueryWithoutSearch.$skip);

  // Ограничение количества записей ($top)
  if (parsedQueryWithoutSearch.$top) {
    queryBuilder = queryBuilder.take(parsedQueryWithoutSearch.$top);
  }

  // Если запрошено количество записей ($count=true), возвращаем { items, count }
  if (parsedQueryWithoutSearch.$count) {
    const resultData = await queryBuilder.getManyAndCount();

    return {
      items: resultData[0],
      count: resultData[1],
    };
  }

  // Иначе возвращаем только массив сущностей
  return queryBuilder.getMany();
};
