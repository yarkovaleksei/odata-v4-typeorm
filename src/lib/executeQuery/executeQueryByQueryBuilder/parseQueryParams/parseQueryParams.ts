/**
 * @file Нормализация query-параметров OData перед выполнением запроса.
 *
 * HTTP-клиенты и Express передают значения в основном строками; здесь:
 * - `$search` — обрезаются пробелы, пустые строки становятся `undefined` (поиск не применяется).
 * - `$top` / `$skip` — приводятся к целым числам (десятичная система), нечисловые строки → `0`.
 * - `$count` — по умолчанию `true`, если параметр отсутствует; строки `'true'`/`'false'` (без учёта регистра)
 *   и булевы значения преобразуются в boolean; любое другое значение после приведения к строке → `false`.
 *
 * Остальные ключи (`$filter`, `$orderby`, …) копируются как есть в поверхностный клон объекта.
 *
 * ЧЕГО ЗДЕСЬ НЕТ (и что стоит держать в голове на уровне приложения):
 * - валидации диапазона: отрицательный `$top` доходит до `take(-5)` и молча игнорируется TypeORM,
 *   а слишком большой (`$top=999999999999`) валит уже парсер OData ошибкой `Fail at 0`;
 * - верхней границы страницы: `$top` не ограничен сверху, клиент может запросить всю таблицу;
 * - отбрасывания дробной части предупреждением: `$top=3.14` тихо станет `3` (поведение `parseInt`).
 * См. `docs/roadmap.md`, задача R-10.
 */
import type { ParsedQueryParams, QueryParams } from '../../../types';

/**
 * Интерпретация OData `$count` и аналогичных булевых флагов из строки запроса.
 *
 * Намеренно строгая: истиной считается только литерал `'true'` (в любом регистре) или `true`.
 * Всё остальное — `'1'`, `'yes'`, пустая строка, объект — даёт `false`. Так поведение
 * не зависит от того, чем клиент сериализовал булево значение.
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
 * @param query - сырой или частично разобранный объект параметров (обычно `req.query`).
 * @returns новый объект с гарантированными типами для `$top`, `$skip`, `$count`
 *   и нормализованным `$search`. Входной объект не мутируется.
 *
 * @remarks `$count` по умолчанию — `true`. Это осознанное отличие от спецификации OData v4,
 *   где отсутствующий `$count` означает `false`; здесь клиент по умолчанию получает
 *   `{ items, count }`. Чтобы получить голый массив, нужно явно передать `$count=false`.
 *
 * @example
 * parseQueryParams({ $top: '10', $skip: ' 5 ', $search: '  ' });
 * // → { $top: 10, $skip: 5, $search: undefined, $count: true }
 */
export const parseQueryParams = (query: ParsedQueryParams | QueryParams): ParsedQueryParams => {
  // Поверхностная копия, чтобы не мутировать входной объект (например, `req.query`).
  // Копия поверхностная сознательно: значения здесь — примитивы, вложенных структур у OData-параметров нет.
  const parsedQuery = { ...query } as unknown as ParsedQueryParams;

  // Пустая или пробельная строка поиска приравнивается к отсутствию $search:
  // иначе processSearch сгенерировал бы LIKE '%%', который совпадает со всем, кроме NULL.
  parsedQuery.$search =
    typeof query.$search === 'string' && query.$search.trim().length > 0
      ? query.$search.trim()
      : undefined;

  // МЁРТВЫЙ КОД. Весь блок ниже вычисляет parsedQuery.$top, который безусловно перезаписывается
  // строкой `parsedQuery.$top = toNumber(query.$top)` сразу после него. Логика при этом дублирует
  // toNumber(), разве что без trim() перед parseInt. Удаляется без изменения поведения —
  // см. `docs/roadmap.md`, задача R-21.
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

  // Единственные строки, реально определяющие итоговые значения.
  parsedQuery.$top = toNumber(query.$top);
  parsedQuery.$skip = toNumber(query.$skip);
  // Отсутствующий $count → true (см. @remarks выше); присутствующий разбирается строго.
  parsedQuery.$count = typeof query.$count === 'undefined' ? true : booleanByString(query.$count);

  return parsedQuery;
};
