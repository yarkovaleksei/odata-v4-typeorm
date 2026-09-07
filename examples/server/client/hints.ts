/**
 * @file Подсказки с именами полей и связей выбранной сущности.
 *
 * Одно и то же подсказывается тремя способами, потому что пользуются ими по-разному:
 * фишки — чтобы собрать список мышкой, `datalist` — чтобы дополнить набранное
 * с клавиатуры, placeholder — чтобы увидеть формат, ничего не нажимая.
 */
import { fillDatalist, form, ui } from './dom.js';
import { kindOf } from './edm.js';
import { findRelationTarget } from './schema.js';
import { refreshUrl } from './query.js';
import type { SchemaResource } from './types.js';

/**
 * Разбирает список через запятую в имена верхнего уровня.
 *
 * Для `$expand` значение бывает с вложенными опциями (`author($select=name)`), поэтому
 * берётся всё до первой скобки: подсветить нужно саму связь, а не её настройки.
 */
function parseTokens(value: string): string[] {
  return value
    .split(',')
    .map((token) => token.split('(')[0]?.trim() ?? '')
    .filter(Boolean);
}

/** Добавляет имя в список через запятую либо убирает его оттуда. */
export function toggleToken(input: HTMLInputElement, name: string): void {
  const tokens = input.value
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);

  const index = tokens.findIndex((token) => token.split('(')[0]?.trim() === name);

  if (index === -1) {
    tokens.push(name);
  } else {
    tokens.splice(index, 1);
  }

  input.value = tokens.join(',');

  refreshUrl();
  markActiveChips();
}

/** Подсвечивает фишки, уже попавшие в поле ввода. */
export function markActiveChips(): void {
  const mark = (container: HTMLElement, input: HTMLInputElement): void => {
    const active = parseTokens(input.value);

    for (const chip of container.querySelectorAll<HTMLElement>('.chip')) {
      chip.classList.toggle('chip--active', active.includes(chip.dataset.name ?? ''));
    }
  };

  mark(ui.selectChips, form.select);
  mark(ui.expandChips, form.expand);
}

function createChip(name: string, title: string, extraClass?: string): HTMLButtonElement {
  const chip = document.createElement('button');

  chip.type = 'button';
  chip.className = extraClass ? `chip ${extraClass}` : 'chip';
  chip.dataset.name = name;
  chip.textContent = name;
  chip.title = title;

  return chip;
}

/** Пример выражения для placeholder у `$filter` — по первому подходящему полю. */
function buildFilterPlaceholder(resource: SchemaResource): string {
  const string = resource.fields.find((field) => kindOf(field) === 'string');
  const number = resource.fields.find((field) => kindOf(field) === 'number');

  if (string && number) {
    return `contains(${string.name},'a') and ${number.name} gt 1`;
  }

  return `${resource.fields[0]?.name ?? 'id'} ne null`;
}

/** Сообщение вместо подсказок, когда схему загрузить не удалось. */
export function renderSchemaUnavailable(): void {
  ui.selectChips.innerHTML = '';
  ui.expandChips.innerHTML = '';
  ui.resourceHint.textContent = 'Схема недоступна: сервер не ответил на /api/$schema.';
}

/** Перерисовывает все подсказки под выбранную сущность. */
export function renderFieldHints(resource: SchemaResource, schema: SchemaResource[]): void {
  ui.selectChips.innerHTML = '';
  ui.expandChips.innerHTML = '';

  const fieldNames = resource.fields.map((field) => field.name);
  const relationNames = resource.relations.map((relation) => relation.name);

  ui.resourceHint.textContent =
    `Сущность ${resource.alias}: ${fieldNames.length} полей, ${relationNames.length} связей. ` +
    'Нажимайте на подсказки ниже, чтобы собрать список.';

  for (const field of resource.fields) {
    const nullable = field.nullable ? ', может быть null' : '';

    ui.selectChips.appendChild(
      createChip(field.name, `${field.edmType} (${field.type}${nullable})`)
    );
  }

  for (const relation of resource.relations) {
    const kind = relation.collection ? 'коллекция' : 'одна запись';

    ui.expandChips.appendChild(
      createChip(
        relation.name,
        `${kind} → ${relation.target}`,
        relation.collection ? 'chip--collection' : undefined
      )
    );
  }

  // В $select допустимы и пути по связям, поэтому в дополнение к своим колонкам
  // подсказываются `связь/поле` — их через фишки не наберёшь.
  const relationPaths = resource.relations.flatMap((relation) => {
    const target = findRelationTarget(schema, relation);

    return target ? target.fields.map((field) => `${relation.name}/${field.name}`) : [];
  });

  fillDatalist(ui.selectOptions, [...fieldNames, ...relationPaths]);
  fillDatalist(ui.expandOptions, relationNames);

  // Направление выбирается отдельным списком, поэтому здесь только имена — и свои,
  // и пути по связям: сортировать по полю связи (`author/name`) OData позволяет.
  fillDatalist(ui.orderbyOptions, [...fieldNames, ...relationPaths]);

  form.select.placeholder = fieldNames.slice(0, 2).join(',') || 'id';
  form.expand.placeholder = relationNames.slice(0, 2).join(',') || 'связей нет';
  form.orderby.placeholder = fieldNames[0] ?? 'id';
  form.filter.placeholder = buildFilterPlaceholder(resource);

  markActiveChips();
}
