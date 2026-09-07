/**
 * @file Сборка URL из полей формы и выполнение запроса.
 *
 * URL пересобирается на каждое изменение, а не только по нажатию кнопки: связь между
 * полем формы и куском строки запроса — главное, чему учит страница.
 */
import { form, ui } from './dom.js';

/** Направление сортировки, если в выражении его не записали: умолчание OData. */
const DEFAULT_DIRECTION = 'asc';

/** Хвост выражения сортировки: ` asc` либо ` desc` в любом регистре. */
const DIRECTION_SUFFIX = /\s+(asc|desc)\s*$/i;

/**
 * Собирает значение `$orderby` из двух полей формы.
 *
 * Направление у последнего поля снимается перед подстановкой выбранного: иначе
 * набранное руками `name desc` вместе со списком дало бы `name desc asc` — выражение,
 * которое сервер обязан отвергнуть. Источник правды один, и это выпадающий список;
 * URL пересобирается на каждое изменение, поэтому подмена видна сразу.
 *
 * Список полей в поле ввода при этом сохраняется: `name desc,id` плюс `asc` даёт
 * `name desc,id asc` — направление относится к последнему полю, как и в самом OData.
 */
export function buildOrderBy(fields: string, direction: string): string {
  const trimmed = fields.trim();

  return trimmed === '' ? '' : `${trimmed.replace(DIRECTION_SUFFIX, '')} ${direction}`;
}

/**
 * Разбирает значение `$orderby` обратно на поля и направление.
 *
 * Нужно примерам: они приходят готовым выражением (`name desc`), а на форме теперь
 * два элемента. Выражение без направления читается как `asc` — так же его понимает
 * и сервер.
 */
export function splitOrderBy(value: string): { fields: string; direction: string } {
  const match = DIRECTION_SUFFIX.exec(value);

  if (!match) {
    return { fields: value.trim(), direction: DEFAULT_DIRECTION };
  }

  return {
    fields: value.slice(0, match.index).trim(),
    direction: (match[1] as string).toLowerCase(),
  };
}

/** Собирает адрес запроса из непустых полей формы. */
export function buildQuery(): string {
  const params = new URLSearchParams();
  const add = (key: string, value: string): void => {
    const trimmed = value.trim();

    if (trimmed !== '') {
      params.set(key, trimmed);
    }
  };

  add('$filter', form.filter.value);
  add('$select', form.select.value);
  add('$expand', form.expand.value);
  add('$orderby', buildOrderBy(form.orderby.value, form.orderbyDirection.value));
  add('$top', form.top.value);
  add('$skip', form.skip.value);
  add('$search', form.search.value);

  // Отсутствующий $count по спецификации означает false, поэтому в URL он появляется,
  // только когда пользователь его включил — так URL остаётся минимальным и честным.
  if (form.count.checked) {
    params.set('$count', 'true');
  }

  const query = params.toString();

  return `/api/${form.resource.value}${query ? `?${query}` : ''}`;
}

export function refreshUrl(): void {
  ui.url.textContent = buildQuery();
}

type StatusKind = 'idle' | 'ok' | 'error';

export function setStatus(text: string, kind: StatusKind): void {
  ui.status.textContent = text;
  ui.status.className = `status status--${kind}`;
}

/** Выполняет собранный запрос и показывает ответ. */
export async function run(): Promise<void> {
  const url = buildQuery();

  setStatus('выполняется…', 'idle');
  ui.timing.textContent = '';

  const startedAt = performance.now();

  try {
    const response = await fetch(url);
    const elapsed = Math.round(performance.now() - startedAt);
    const body: unknown = await response.json();

    ui.output.textContent = JSON.stringify(body, null, 2);
    ui.timing.textContent = `${elapsed} мс`;

    // 400 здесь — штатный, а не аварийный исход: именно так библиотека сообщает,
    // что запрос выполнить нельзя, вместо того чтобы вернуть неполный результат.
    setStatus(`HTTP ${response.status}`, response.ok ? 'ok' : 'error');
  } catch (error) {
    ui.output.textContent = String(error);
    setStatus('сеть недоступна', 'error');
  }
}
