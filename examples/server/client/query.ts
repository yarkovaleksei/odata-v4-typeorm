/**
 * @file Сборка URL из полей формы и выполнение запроса.
 *
 * URL пересобирается на каждое изменение, а не только по нажатию кнопки: связь между
 * полем формы и куском строки запроса — главное, чему учит страница.
 */
import { form, ui } from './dom.js';

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
  add('$orderby', form.orderby.value);
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
