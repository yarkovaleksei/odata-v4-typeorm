/**
 * @file Вывод списка примеров.
 *
 * Отделено от {@link generateExamples}: там логика, которую хочется читать и проверять
 * отдельно, здесь — работа с DOM.
 */
import { ui } from './dom.js';
import type { Example } from './types.js';

/** Строка запроса примера в человекочитаемом виде — она же подпись на кнопке. */
function describeQuery(example: Example): string {
  const parts = Object.entries(example.query).map(([key, value]) => `${key}=${value}`);

  return parts.length ? parts.join('&') : 'без параметров';
}

/**
 * Перерисовывает список примеров.
 *
 * @param examples - что показать.
 * @param onPick - что сделать по нажатию; страница подставляет пример в форму и выполняет.
 */
export function renderExamples(examples: Example[], onPick: (example: Example) => void): void {
  ui.examples.innerHTML = '';

  for (const example of examples) {
    const item = document.createElement('li');
    const button = document.createElement('button');

    button.type = 'button';

    const title = document.createElement('span');

    title.className = 'example-title';
    title.textContent = example.title;

    if (example.expectError) {
      const tag = document.createElement('span');

      tag.className = 'tag tag--error';
      tag.textContent = '400';
      title.appendChild(tag);
    }

    const query = document.createElement('span');

    query.className = 'example-query';
    query.textContent = describeQuery(example);

    button.append(title, query);
    button.addEventListener('click', () => onPick(example));

    item.appendChild(button);
    ui.examples.appendChild(item);
  }
}
