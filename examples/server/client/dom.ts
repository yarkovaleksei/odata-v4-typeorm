/**
 * @file Ссылки на элементы страницы.
 *
 * Собраны в одном месте и типизированы: остальные модули работают с полями формы
 * как с обычными объектами, не повторяя `getElementById` и приведения типов.
 *
 * Отсутствие элемента — ошибка сборки страницы, а не штатная ситуация, поэтому
 * {@link byId} бросает исключение. Молчаливый `null` привёл бы к тому, что часть
 * страницы просто перестала бы работать без единого сообщения.
 */

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);

  if (!element) {
    throw new Error(`Разметка и скрипт разошлись: на странице нет элемента #${id}`);
  }

  return element as T;
}

/** Поля формы: из них собирается запрос. */
export const form = {
  resource: byId<HTMLSelectElement>('resource'),
  filter: byId<HTMLTextAreaElement>('filter'),
  select: byId<HTMLInputElement>('select'),
  expand: byId<HTMLInputElement>('expand'),
  /**
   * `$compute`: выражение под именем. Обычное текстовое поле без подсказок по схеме —
   * имя справа от `as` придумывает пользователь, и предложить его страница не может.
   */
  compute: byId<HTMLInputElement>('compute'),
  orderby: byId<HTMLInputElement>('orderby'),
  /**
   * Направление сортировки отдельным списком: в `$orderby` оно записывается словом
   * (`name desc`), и набирать его руками — единственное, что мешало собрать сортировку
   * мышкой целиком. Значение всегда непустое, поэтому в {@link TEXT_FIELDS} его нет —
   * очистка возвращает его к `asc`, а не к пустой строке.
   */
  orderbyDirection: byId<HTMLSelectElement>('orderby-direction'),
  top: byId<HTMLInputElement>('top'),
  skip: byId<HTMLInputElement>('skip'),
  search: byId<HTMLInputElement>('search'),
  count: byId<HTMLInputElement>('count'),
};

/** Поля формы, которые очищаются кнопкой «Очистить». */
export const TEXT_FIELDS = [
  'filter',
  'select',
  'expand',
  'compute',
  'orderby',
  'top',
  'skip',
  'search',
] as const;

/** Всё остальное: вывод, подсказки, списки. */
export const ui = {
  url: byId('url'),
  output: byId('output'),
  status: byId('status'),
  timing: byId('timing'),
  resourceHint: byId('resource-hint'),
  examples: byId('examples'),
  examplesResource: byId('examples-resource'),
  selectChips: byId('select-chips'),
  expandChips: byId('expand-chips'),
  selectOptions: byId<HTMLDataListElement>('select-options'),
  expandOptions: byId<HTMLDataListElement>('expand-options'),
  orderbyOptions: byId<HTMLDataListElement>('orderby-options'),
  run: byId<HTMLButtonElement>('run'),
  reset: byId<HTMLButtonElement>('reset'),
  copy: byId<HTMLButtonElement>('copy'),
  theme: byId<HTMLButtonElement>('theme'),
};

/** Заполняет `<datalist>` — подсказки для ввода с клавиатуры. */
export function fillDatalist(datalist: HTMLDataListElement, values: string[]): void {
  datalist.innerHTML = '';

  for (const value of values) {
    const option = document.createElement('option');

    option.value = value;
    datalist.appendChild(option);
  }
}
