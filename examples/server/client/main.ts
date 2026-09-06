/**
 * @file Точка входа: состояние страницы и связывание модулей.
 *
 * Всё изменяемое состояние держится здесь — схема и образцы строк. Остальные модули
 * получают их параметрами и ничего не хранят, поэтому их можно читать и проверять
 * по отдельности.
 *
 * НИЧЕГО О СХЕМЕ НЕ ЗАШИТО. Список сущностей, подсказки полей и все примеры строятся
 * из ответа `/api/$schema`, поэтому правка сущности сразу видна на странице.
 */
import { form, TEXT_FIELDS, ui } from './dom.js';
import { generateExamples } from './examples.js';
import { markActiveChips, renderFieldHints, renderSchemaUnavailable, toggleToken } from './hints.js';
import { buildQuery, refreshUrl, run, setStatus } from './query.js';
import { renderExamples } from './render.js';
import { findResource, loadSchema } from './schema.js';
import { loadSampleRows } from './samples.js';
import type { Example, Row, SchemaResource } from './types.js';

/** Описание всех опубликованных ресурсов; загружается один раз при старте. */
let schema: SchemaResource[] = [];

/** Образцы строк выбранной сущности — из них берутся значения для примеров. */
let sampleRows: Row[] = [];

function currentResource(): SchemaResource | undefined {
  return findResource(schema, form.resource.value);
}

/** Подставляет пример в форму и сразу выполняет его. */
function applyExample(example: Example): void {
  form.filter.value = example.query.$filter ?? '';
  form.select.value = example.query.$select ?? '';
  form.expand.value = example.query.$expand ?? '';
  form.orderby.value = example.query.$orderby ?? '';
  form.top.value = example.query.$top ?? '';
  form.skip.value = example.query.$skip ?? '';
  form.search.value = example.query.$search ?? '';
  form.count.checked = example.query.$count === 'true';

  markActiveChips();
  refreshUrl();
  void run();
}

function reset(): void {
  for (const key of TEXT_FIELDS) {
    form[key].value = '';
  }

  form.count.checked = false;

  ui.output.textContent = 'Нажмите «Выполнить», чтобы увидеть ответ.';
  setStatus('готов', 'idle');
  ui.timing.textContent = '';
  markActiveChips();
  refreshUrl();
}

/** Перестраивает всё, что зависит от выбранной сущности. */
async function refreshResource(): Promise<void> {
  const resource = currentResource();

  refreshUrl();

  if (!resource) {
    renderSchemaUnavailable();
    renderExamples([], applyExample);

    return;
  }

  renderFieldHints(resource, schema);
  ui.examplesResource.textContent = `/api/${resource.name}`;

  sampleRows = await loadSampleRows(resource);

  // Пока грузились строки, пользователь мог выбрать другую сущность.
  if (currentResource() !== resource) {
    return;
  }

  renderExamples(generateExamples(resource, schema, sampleRows), applyExample);
}

function bindEvents(): void {
  // Пересборка URL на любое изменение: она и есть главное, чему учит страница.
  for (const element of Object.values(form)) {
    element.addEventListener('input', refreshUrl);
    element.addEventListener('change', refreshUrl);
  }

  // Подсветка фишек следует за ручной правкой полей, а не только за нажатиями на них.
  form.select.addEventListener('input', markActiveChips);
  form.expand.addEventListener('input', markActiveChips);

  const bindChips = (container: HTMLElement, input: HTMLInputElement): void => {
    container.addEventListener('click', (event) => {
      const chip = (event.target as HTMLElement).closest<HTMLElement>('.chip');

      if (chip?.dataset.name) {
        toggleToken(input, chip.dataset.name);
      }
    });
  };

  bindChips(ui.selectChips, form.select);
  bindChips(ui.expandChips, form.expand);

  // Смена сущности обнуляет форму: поля прежней сущности в новой не существуют,
  // и оставленный `$select` дал бы 400 на ровном месте.
  form.resource.addEventListener('change', () => {
    reset();
    void refreshResource();
  });

  ui.run.addEventListener('click', () => void run());
  ui.reset.addEventListener('click', reset);
  ui.copy.addEventListener('click', () => {
    void navigator.clipboard.writeText(new URL(buildQuery(), location.origin).toString());
  });
}

async function init(): Promise<void> {
  schema = await loadSchema();

  for (const resource of schema) {
    const option = document.createElement('option');

    option.value = resource.name;
    option.textContent = `/api/${resource.name}`;
    form.resource.appendChild(option);
  }

  bindEvents();

  await refreshResource();
}

void init();
