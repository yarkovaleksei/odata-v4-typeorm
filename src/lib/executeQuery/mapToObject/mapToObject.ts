/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unnecessary-type-constraint */
/**
 * Преобразует `Map` параметров из `odata-v4-sql` / `TypeOrmVisitor` в plain-object
 * для `QueryBuilder.setParameters`.
 *
 * Мостик между двумя API: посетитель накапливает значения плейсхолдеров `:p0`, `:p1`, … в `Map`,
 * а `setParameters` принимает только обычный объект `{ p0: …, p1: … }`.
 *
 * Возврат пустого объекта на `null`/`undefined` избавляет вызывающий код от проверок:
 * `setParameters({})` — корректный no-op.
 *
 * @param map - исходный Map (может быть null или undefined)
 * @param deep - рекурсивно разворачивать вложенные `Map`. Для параметров запроса не нужно
 *   (значения там — примитивы); режим оставлен для переиспользования функции в других местах.
 * @returns объект, представляющий исходный Map, или пустой объект, если map пуст/не определён
 *
 * @example
 * mapToObject(new Map([['p0', 'Ann'], ['p1', 18]]));
 * // → { p0: 'Ann', p1: 18 }
 */
export function mapToObject<TKey extends string | number | symbol, TValue extends any>(
  map: Map<TKey, TValue> | null | undefined,
  deep: boolean = false
): Record<TKey, TValue> {
  if (!map) {
    return {} as Record<TKey, TValue>;
  }

  // Быстрый путь: Object.fromEntries уже делает ровно то, что нужно для плоского Map.
  if (!deep) {
    return Object.fromEntries(map) as Record<TKey, TValue>;
  }

  const result: Record<TKey, TValue> = {} as Record<TKey, TValue>;

  for (const [key, value] of map) {
    // @ts-ignore — результат рекурсии (Record) не сводится к TValue на уровне типов,
    // но по контракту функции значение-Map и должно превратиться в объект.
    result[key as any] = isMap(value) ? mapToObject(value as any, deep) : value;
  }

  return result;
}

/**
 * Type guard: значение является `Map`.
 * Вынесен отдельно, чтобы `mapToObject` читался без встроенного `instanceof`.
 */
function isMap(value: unknown): value is Map<unknown, unknown> {
  return value instanceof Map;
}
