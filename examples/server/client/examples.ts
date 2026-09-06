/**
 * @file Сборка примеров запросов под выбранную сущность.
 *
 * Главный модуль страницы и единственный, который стоит читать, чтобы понять, откуда
 * берутся примеры. Раньше они были записаны константой и после правки сущности молча
 * начинали ссылаться на поля, которых уже нет.
 *
 * ФУНКЦИЯ ЧИСТАЯ. Ни DOM, ни сети: на вход — схема и строки, на выход — список примеров.
 * Так её можно прогнать в Node и проверить каждый пример против живого сервера,
 * не поднимая браузер.
 *
 * ДВА ПРАВИЛА, которым подчиняется каждый пример:
 *
 * 1. он добавляется, только если в схеме есть подходящее поле или связь — у сущности
 *    из двух колонок примеров будет меньше, и ни один не сошлётся на несуществующее;
 * 2. он возвращает непустую выборку — значения берутся из реальных строк. Пример,
 *    отдающий пустой массив, не показывает, работает фильтр или нет.
 */
import { kindOf } from './edm.js';
import { findRelationTarget } from './schema.js';
import {
  fragmentOf,
  hasNull,
  maxValueOf,
  quote,
  relationValueOf,
  valueOf,
} from './samples.js';
import type { Example, QueryDraft, Row, SchemaResource } from './types.js';

/**
 * Собирает примеры под сущность.
 *
 * @param resource - описание выбранной сущности.
 * @param schema - вся схема: нужна, чтобы узнать поля сущностей на другом конце связей.
 * @param rows - образцы строк; пустой массив допустим — тогда останутся примеры,
 *   которым значения не нужны.
 */
export function generateExamples(
  resource: SchemaResource,
  schema: SchemaResource[],
  rows: Row[]
): Example[] {
  const examples: Example[] = [];
  const add = (title: string, query: QueryDraft, expectError?: boolean): void => {
    examples.push(expectError ? { title, query, expectError } : { title, query });
  };

  const names = resource.fields.map((field) => field.name);
  const byKind = (kind: string) => resource.fields.filter((field) => kindOf(field) === kind);

  const first = names[0] ?? 'id';
  const orderField = names.find((name) => name !== first) ?? first;

  // ── Базовые: нужны только имена полей ──────────────────────────────────────
  add('Все записи', {});

  if (names.length > 1) {
    add('Выбор полей', { $select: names.slice(0, 2).join(',') });
  }

  add('Сортировка', { $orderby: `${orderField} desc` });
  add('Пагинация со счётчиком', {
    $orderby: `${first} asc`,
    $top: '2',
    $skip: '1',
    $count: 'true',
  });
  add('Пустая страница, только счётчик', { $top: '0', $count: 'true' });

  // ── Фильтры по типам полей ────────────────────────────────────────────────
  const [stringField] = byKind('string');
  const [booleanField] = byKind('boolean');
  const [dateField] = byKind('datetime');

  // Первичный ключ берётся только за неимением другого числового поля: `id ge 1` вернёт
  // все строки и ничего не покажет, а `age ge 45` — покажет работу фильтра.
  const numbers = byKind('number');
  const numberField = numbers.find((field) => field.name !== 'id') ?? numbers[0];

  if (stringField) {
    const value = valueOf(rows, stringField.name);

    if (value !== undefined) {
      const name = stringField.name;

      add('Поиск по подстроке', { $filter: `contains(${name},${quote(fragmentOf(value))})` });
      add('Равенство строк', { $filter: `${name} eq ${quote(value)}` });
      add('Строковые функции', {
        $filter: `length(${name}) gt 2 and startswith(${name},${quote(String(value).slice(0, 1))})`,
      });
      add('Поиск по всем полям ($search)', { $search: fragmentOf(value) });
    }
  }

  if (numberField) {
    const threshold = maxValueOf(rows, numberField.name);

    if (threshold !== undefined) {
      const name = numberField.name;

      add('Сравнение чисел', { $filter: `${name} ge ${threshold}`, $orderby: `${name} asc` });
      add('Арифметика', { $filter: `${name} mul 2 ge ${threshold * 2}` });
    }
  }

  if (booleanField) {
    const value = valueOf(rows, booleanField.name);

    if (value !== undefined) {
      add('Булево поле', { $filter: `${booleanField.name} eq ${Boolean(value)}` });
    }
  }

  if (dateField) {
    const value = valueOf(rows, dateField.name);
    const year = value === undefined ? Number.NaN : new Date(String(value)).getFullYear();

    if (Number.isFinite(year)) {
      add('Функции даты', { $filter: `year(${dateField.name}) eq ${year}` });
    }
  }

  const nullableField = resource.fields.find(
    (field) => field.nullable && hasNull(rows, field.name)
  );

  if (nullableField) {
    add('Сравнение с null', { $filter: `${nullableField.name} eq null` });
    add('Отрицание — нужны явные скобки', {
      $filter: `(not (${nullableField.name} eq null)) and ${first} ge 1`,
    });
  }

  // ── Связи ─────────────────────────────────────────────────────────────────
  const single = resource.relations.find((relation) => !relation.collection);
  const collection = resource.relations.find((relation) => relation.collection);

  if (single) {
    add('Связь «к одному»', { $expand: single.name });

    const target = findRelationTarget(schema, single);
    const targetField = target?.fields.find((field) => kindOf(field) === 'string');

    if (targetField) {
      const value = relationValueOf(rows, single.name, targetField.name);

      if (value !== undefined) {
        add('Фильтр по полю связи', {
          $filter: `${single.name}/${targetField.name} eq ${quote(value)}`,
          $expand: single.name,
        });
      }

      add('Вложенный $select внутри $expand', {
        $expand: `${single.name}($select=${targetField.name})`,
        $select: names.slice(0, 2).join(','),
      });
      add('Сортировка по полю связи', {
        $orderby: `${single.name}/${targetField.name} asc`,
        $expand: single.name,
      });
    }
  }

  if (collection) {
    add('Связь «ко многим»', { $expand: collection.name });
    add('Вложенная пагинация внутри $expand', {
      $expand: `${collection.name}($orderby=id desc;$top=1)`,
    });

    const target = findRelationTarget(schema, collection);
    const candidates = target?.relations.filter((relation) => !relation.collection) ?? [];

    // Предпочитается связь, ведущая к третьей сущности: `books($expand=author)` показывает
    // три уровня, а `posts($expand=user)` возвращает к той, с которой начали, и выглядит
    // как ошибка, хотя и работает.
    const nested =
      candidates.find((relation) => relation.target !== resource.alias) ?? candidates[0];

    if (nested) {
      add('Три уровня $expand', { $expand: `${collection.name}($expand=${nested.name})` });
    }
  }

  // ── Отказы ────────────────────────────────────────────────────────────────
  // Библиотека никогда не выполняет запрос частично: непереводимая конструкция,
  // несуществующее поле и недопустимое значение параметра дают 400, а не тихую подмену
  // результата. Ради этого примеры-отказы и держатся на видном месте.
  if (collection) {
    add('Лямбда any — не поддерживается', { $filter: `${collection.name}/any(x: x/id eq 1)` }, true);
  }

  add('Несуществующее поле', { $filter: 'nonexistent eq 1' }, true);
  add('Отрицательный $top', { $top: '-5' }, true);

  return examples;
}
