/**
 * @file Группировка типов EDM в категории, по которым подбирается выражение OData.
 *
 * Точный тип (`Edm.Int16` против `Edm.Decimal`) для примеров не важен — важно, что это
 * число, а не строка: к числу применимо сравнение и арифметика, к строке — `contains`
 * и `startswith`, к дате — `year()`.
 *
 * Сами типы приходят с сервера в ответе `/api/$schema`; выводить их здесь из имени типа
 * колонки СУБД значило бы держать вторую копию таблицы соответствий, которая уже есть
 * в библиотеке (`resolveEdmType`).
 */
import type { SchemaField } from './types.js';

/** Категория поля: по ней выбирается уместное выражение. */
export type FieldKind = 'string' | 'number' | 'boolean' | 'datetime' | 'time' | 'other';

const EDM_KINDS: Record<Exclude<FieldKind, 'other'>, readonly string[]> = {
  string: ['Edm.String', 'Edm.Guid'],
  number: [
    'Edm.Byte',
    'Edm.Int16',
    'Edm.Int32',
    'Edm.Int64',
    'Edm.Single',
    'Edm.Double',
    'Edm.Decimal',
  ],
  boolean: ['Edm.Boolean'],
  datetime: ['Edm.DateTimeOffset', 'Edm.Date'],
  time: ['Edm.TimeOfDay'],
};

/** Категория поля; `'other'` — для типов, к которым не подобрать выражение вслепую. */
export function kindOf(field: SchemaField): FieldKind {
  const entry = Object.entries(EDM_KINDS).find(([, types]) => types.includes(field.edmType));

  return entry ? (entry[0] as FieldKind) : 'other';
}
