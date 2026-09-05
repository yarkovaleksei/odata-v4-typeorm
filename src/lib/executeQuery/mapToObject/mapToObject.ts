/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unnecessary-type-constraint */
/**
 * Преобразует `Map` параметров из `odata-v4-sql` / `TypeOrmVisitor` в plain-object для `QueryBuilder.setParameters`.
 *
 * TypeORM ожидает объект `{ [name]: value }`; посетитель накапливает плейсхолдеры `:p0`, `:p1`, … в `Map`.
 * Режим `deep` нужен на случай вложенных `Map` (редко), чтобы рекурсивно развернуть структуру.
 *
 * @param map - исходный Map (может быть null или undefined)
 * @param deep - если true, рекурсивно преобразует вложенные Map в объекты (по умолчанию false)
 * @returns объект, представляющий исходный Map, или пустой объект, если map пуст/не определён
 */
export function mapToObject<TKey extends string | number | symbol, TValue extends any>(
  map: Map<TKey, TValue> | null | undefined,
  deep: boolean = false
): Record<TKey, TValue> {
  if (!map) {
    return {} as Record<TKey, TValue>;
  }

  if (!deep) {
    return Object.fromEntries(map) as Record<TKey, TValue>;
  }

  const result: Record<TKey, TValue> = {} as Record<TKey, TValue>;

  for (const [key, value] of map) {
    // @ts-ignore
    result[key as any] = isMap(value) ? mapToObject(value as any, deep) : value;
  }

  return result;
}

/**
 * Проверяет, является ли значение экземпляром Map.
 */
function isMap(value: unknown): value is Map<unknown, unknown> {
  return value instanceof Map;
}
