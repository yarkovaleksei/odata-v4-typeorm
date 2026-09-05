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
 * `$top` отличает «не передан» (`undefined`) от «передан ноль» (`0`): по OData v4, раздел 11.2.6.4,
 * `$top=0` — корректный запрос пустой страницы, а не синоним отсутствия лимита.
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
 * Безопасное приведение к целому для `$skip`: пустые и пробельные строки → `0`;
 * для строк используется `parseInt(..., 10)` (дробная часть отбрасывается: `'3.14'` → `3`).
 */
function toNumber(value?: string | number): number {
  return toOptionalNumber(value) ?? 0;
}

/**
 * Приведение к целому с сохранением различия «параметр не передан» и «передан ноль».
 *
 * Нужно для `$top`: по OData v4 (раздел 11.2.6.4) `$top=0` — корректный запрос,
 * означающий «вернуть пустую страницу», тогда как отсутствие `$top` означает
 * «лимита нет». Если оба случая свести к `0`, различить их дальше по конвейеру
 * уже невозможно.
 *
 * Нечисловая строка (`'invalid'`) даёт `0`, а не `undefined`: это всё же переданное
 * значение, просто некорректное, и трактовать его как «лимита нет» опаснее.
 */
function toOptionalNumber(value?: string | number): number | undefined {
  if (typeof value === 'number') {
    return value;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return undefined;
  }

  const parsed = parseInt(trimmed, 10);

  return Number.isNaN(parsed) ? 0 : parsed;
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

  // $top сохраняет различие «не передан» (undefined) и «передан ноль» (0) — см. toOptionalNumber.
  parsedQuery.$top = toOptionalNumber(query.$top);
  // Для $skip такое различие не нужно: skip(0) и отсутствие смещения — это одно и то же.
  parsedQuery.$skip = toNumber(query.$skip);
  // Отсутствующий $count → true (см. @remarks выше); присутствующий разбирается строго.
  parsedQuery.$count = typeof query.$count === 'undefined' ? true : booleanByString(query.$count);

  return parsedQuery;
};
