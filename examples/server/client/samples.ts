/**
 * @file Образцы строк выбранной сущности и извлечение значений из них.
 *
 * ЗАЧЕМ ПРИМЕРАМ РЕАЛЬНЫЕ ДАННЫЕ. По одной схеме можно собрать синтаксически верный
 * фильтр, но не осмысленный: `contains(title,'x')` вернёт пустой массив, и по нему
 * не видно, работает фильтр или нет. Поэтому значения берутся из настоящих строк —
 * тогда каждый пример заведомо что-то находит.
 */
import type { Row, SchemaResource } from './types.js';

/** Сколько строк запрашивать: хватает, чтобы найти и заполненное, и пустое значение. */
const SAMPLE_SIZE = 20;

/**
 * Загружает строки сущности вместе со связями «к одному».
 *
 * Один запрос вместо нескольких: из тех же строк берутся и значения собственных колонок,
 * и значения связанных сущностей для примеров вида `author/name eq 'Ada'`.
 *
 * Пустой массив при любой неудаче — примеры, которым значения не нужны, всё равно соберутся.
 */
export async function loadSampleRows(resource: SchemaResource): Promise<Row[]> {
  const single = resource.relations
    .filter((relation) => !relation.collection)
    .map((relation) => relation.name);

  const params = new URLSearchParams({ $top: String(SAMPLE_SIZE) });

  if (single.length) {
    params.set('$expand', single.join(','));
  }

  try {
    const response = await fetch(`/api/${resource.name}?${params}`);

    if (!response.ok) {
      return [];
    }

    const body: unknown = await response.json();

    if (Array.isArray(body)) {
      return body as Row[];
    }

    const items = (body as { items?: unknown }).items;

    return Array.isArray(items) ? (items as Row[]) : [];
  } catch {
    return [];
  }
}

/** Первое непустое значение поля среди строк. */
export function valueOf(rows: Row[], name: string): unknown {
  const row = rows.find((item) => item[name] !== null && item[name] !== undefined);

  return row?.[name];
}

/** Есть ли строка, где поле пустое. Нужно, чтобы `eq null` не дал пустую выдачу. */
export function hasNull(rows: Row[], name: string): boolean {
  return rows.some((row) => row[name] === null);
}

/**
 * Наибольшее числовое значение поля.
 *
 * Порог для сравнения берётся именно максимальный: `ge max` заведомо вернёт непустую
 * выборку и при этом почти наверняка не всю таблицу — в отличие от `ge min`, которое
 * вернуло бы всё и ничего не показало.
 */
export function maxValueOf(rows: Row[], name: string): number | undefined {
  const values = rows
    .map((row) => Number(row[name]))
    .filter((value) => Number.isFinite(value));

  return values.length ? Math.max(...values) : undefined;
}

/** Значение поля связанной сущности — из строки, где связь заполнена. */
export function relationValueOf(rows: Row[], relation: string, field: string): unknown {
  const row = rows.find((item) => item[relation]);
  const related = row?.[relation];

  if (!related || Array.isArray(related) || typeof related !== 'object') {
    return undefined;
  }

  return (related as Row)[field];
}

/** Строковый литерал OData: одинарная кавычка внутри значения удваивается. */
export function quote(value: unknown): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Фрагмент строки для `contains`: первое слово, обрезанное до шести символов. */
export function fragmentOf(value: unknown): string {
  const word = String(value).trim().split(/\s+/)[0] ?? '';

  return word.slice(0, 6);
}
