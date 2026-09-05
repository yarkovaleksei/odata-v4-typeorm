/**
 * Нормализация query-параметров OData перед выполнением запроса.
 *
 * HTTP-клиенты и Express передают значения в основном строками; здесь:
 * - `$search` — обрезаются пробелы, пустые строки становятся `undefined` (поиск не применяется).
 * - `$top` / `$skip` — приводятся к целым числам (десятичная система), нечисловые строки → `0`.
 * - `$count` — по умолчанию `true`, если параметр отсутствует; строки `'true'`/`'false'` (без учёта регистра)
 *   и булевы значения преобразуются в boolean; любое другое значение после приведения к строке → `false`.
 *
 * Остальные ключи (`$filter`, `$orderby`, …) копируются как есть в поверхностный клон объекта.
 */
import type { ParsedQueryParams, QueryParams } from '../../../types';

/**
 * Интерпретация OData `$count` и аналогичных булевых флагов из строки запроса.
 */
function booleanByString(value?: 'true' | 'false' | string | boolean) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'undefined') {
    return false;
  }

  let localValue = value;

  if (typeof value !== 'string') {
    localValue = String(localValue);
  }

  switch (localValue.toLowerCase()) {
    case 'true':
      return true;
    case 'false':
    default:
      return false;
  }
}

/**
 * Безопасное приведение к целому для `$top`/`$skip`: пустые и пробельные строки → `0`;
 * для строк используется `parseInt(..., 10)` (дробная часть отбрасывается, как в тестах для `'3.14'`).
 */
function toNumber(value?: string | number): number {
  if (typeof value === 'number') return value;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) return 0;

    const parsed = parseInt(trimmed, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  return 0;
}

/**
 * @param query - сырой или частично разобранный объект параметров.
 * @returns новый объект с гарантированными типами для `$top`, `$skip`, `$count` и нормализованным `$search`.
 */
export const parseQueryParams = (query: ParsedQueryParams | QueryParams): ParsedQueryParams => {
  // Поверхностная копия, чтобы не мутировать входной объект (например, `req.query`).
  const parsedQuery = { ...query } as unknown as ParsedQueryParams;

  parsedQuery.$search =
    typeof query.$search === 'string' && query.$search.trim().length > 0
      ? query.$search.trim()
      : undefined;

  // Ниже для `$top` дублируется логика парсинга перед вызовом `toNumber(query.$top)`:
  // итоговое значение всё равно задаётся через `toNumber`. Блок сохранён для совместимости с историей кода.
  if (typeof query.$top === 'string' && query.$top.trim().length > 0) {
    const $top = parseInt(query.$top, 10);

    if (!isNaN($top)) {
      parsedQuery.$top = $top;
    } else {
      parsedQuery.$top = 0;
    }
  } else if (typeof query.$top === 'number') {
    parsedQuery.$top = query.$top;
  } else {
    parsedQuery.$top = 0;
  }

  parsedQuery.$top = toNumber(query.$top);
  parsedQuery.$skip = toNumber(query.$skip);
  parsedQuery.$count = typeof query.$count === 'undefined' ? true : booleanByString(query.$count);

  return parsedQuery;
};
