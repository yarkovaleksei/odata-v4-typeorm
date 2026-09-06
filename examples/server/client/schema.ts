/**
 * @file Загрузка схемы сервиса и поиск по ней.
 *
 * Берётся `/api/$schema`, а не `/api/$metadata`: там лежит стандартный документ OData
 * в CSDL XML, который пришлось бы разбирать, тогда как конструктору нужна готовая
 * выжимка в JSON.
 */
import type { SchemaRelation, SchemaResource } from './types.js';

/**
 * Загружает описание всех опубликованных ресурсов.
 *
 * Ошибка не бросается: без схемы страница обязана открыться и честно сказать, что сервер
 * не ответил, а не показать пустую форму без объяснений.
 */
export async function loadSchema(): Promise<SchemaResource[]> {
  try {
    const response = await fetch('/api/$schema');

    if (!response.ok) {
      return [];
    }

    return (await response.json()) as SchemaResource[];
  } catch {
    return [];
  }
}

/** Ресурс по сегменту маршрута (`books`). */
export function findResource(
  schema: SchemaResource[],
  name: string
): SchemaResource | undefined {
  return schema.find((item) => item.name === name);
}

/**
 * Ресурс, на который ведёт связь.
 *
 * `undefined`, если целевая сущность не опубликована маршрутом: связь тогда работает
 * (её можно развернуть через `$expand`), но её полей мы не знаем и подсказать не можем.
 */
export function findRelationTarget(
  schema: SchemaResource[],
  relation: SchemaRelation
): SchemaResource | undefined {
  return schema.find((item) => item.alias === relation.target);
}
