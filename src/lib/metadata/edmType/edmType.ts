/**
 * @file Соответствие типов колонок TypeORM примитивным типам EDM (OData v4).
 *
 * Тип колонки в TypeORM приходит в двух видах, и оба нужно разбирать:
 *
 * 1. функцией-конструктором (`String`, `Number`, `Boolean`, `Date`) — когда тип выведен
 *    из объявления поля, то есть при `@Column()` без аргументов;
 * 2. строкой с именем типа СУБД (`'integer'`, `'timestamptz'`, `'varchar'`) — когда тип
 *    задан явно.
 *
 * Имена типов у трёх поддерживаемых СУБД пересекаются лишь частично, поэтому таблица
 * перечисляет синонимы всех трёх: `int4` (PostgreSQL), `mediumint` (MySQL), `integer`
 * (все) означают одно и то же.
 *
 * ПРО ПРИБЛИЖЁННЫЕ ЧИСЛА. `float` в MySQL — одинарная точность (`Edm.Single`),
 * в PostgreSQL под тем же именем скрывается двойная. Все они приводятся к `Edm.Double`
 * намеренно: объявить хранилище точнее, чем оно есть, безопасно — клиент не потеряет
 * значение; обратное направление (`Edm.Single` над колонкой `double precision`) обещало
 * бы клиенту меньшую точность, чем приходит на самом деле.
 */
import type { ColumnMetadata } from '../types';

/** Тип EDM, которым описывается колонка неизвестного типа. */
export const FALLBACK_EDM_TYPE = 'Edm.String';

/**
 * Имена типов СУБД → типы EDM.
 *
 * Ключи в нижнем регистре: TypeORM сохраняет тип так, как его записали в декораторе,
 * а `@Column('VARCHAR')` и `@Column('varchar')` — одно и то же.
 */
const EDM_TYPE_BY_COLUMN_TYPE: Readonly<Record<string, string>> = {
  // ── Строки ────────────────────────────────────────────────────────────────
  char: 'Edm.String',
  character: 'Edm.String',
  varchar: 'Edm.String',
  'varchar2': 'Edm.String',
  'character varying': 'Edm.String',
  nchar: 'Edm.String',
  nvarchar: 'Edm.String',
  'national varchar': 'Edm.String',
  text: 'Edm.String',
  ntext: 'Edm.String',
  tinytext: 'Edm.String',
  mediumtext: 'Edm.String',
  longtext: 'Edm.String',
  citext: 'Edm.String',
  // Структурированные значения отдаются клиенту как есть; отдельного типа для них
  // в OData v4 нет, а `Edm.Untyped` появился только в 4.01 и понимается не всеми клиентами.
  json: 'Edm.String',
  jsonb: 'Edm.String',
  'simple-json': 'Edm.String',
  'simple-array': 'Edm.String',
  xml: 'Edm.String',
  // Перечисления TypeORM хранит строками; `EnumType` в CSDL потребовал бы объявления
  // отдельного типа, а фильтровать значение всё равно нужно как строку.
  enum: 'Edm.String',
  'simple-enum': 'Edm.String',
  'set': 'Edm.String',

  // ── Идентификаторы ────────────────────────────────────────────────────────
  uuid: 'Edm.Guid',
  uniqueidentifier: 'Edm.Guid',

  // ── Целые ─────────────────────────────────────────────────────────────────
  tinyint: 'Edm.Byte',
  int2: 'Edm.Int16',
  smallint: 'Edm.Int16',
  smallserial: 'Edm.Int16',
  int: 'Edm.Int32',
  int4: 'Edm.Int32',
  integer: 'Edm.Int32',
  mediumint: 'Edm.Int32',
  serial: 'Edm.Int32',
  year: 'Edm.Int32',
  // TypeORM отдаёт bigint строкой (значение не умещается в number), и `Edm.Int64`
  // в JSON тоже принято передавать строкой — формы совпадают.
  bigint: 'Edm.Int64',
  int8: 'Edm.Int64',
  bigserial: 'Edm.Int64',

  // ── Точные дробные ────────────────────────────────────────────────────────
  decimal: 'Edm.Decimal',
  numeric: 'Edm.Decimal',
  dec: 'Edm.Decimal',
  fixed: 'Edm.Decimal',
  money: 'Edm.Decimal',
  smallmoney: 'Edm.Decimal',

  // ── Приближённые дробные (см. заголовок файла) ────────────────────────────
  float: 'Edm.Double',
  float4: 'Edm.Double',
  float8: 'Edm.Double',
  real: 'Edm.Double',
  double: 'Edm.Double',
  'double precision': 'Edm.Double',

  // ── Логические ────────────────────────────────────────────────────────────
  bool: 'Edm.Boolean',
  boolean: 'Edm.Boolean',

  // ── Дата и время ──────────────────────────────────────────────────────────
  date: 'Edm.Date',
  time: 'Edm.TimeOfDay',
  'time without time zone': 'Edm.TimeOfDay',
  'time with time zone': 'Edm.TimeOfDay',
  datetime: 'Edm.DateTimeOffset',
  datetime2: 'Edm.DateTimeOffset',
  datetimeoffset: 'Edm.DateTimeOffset',
  smalldatetime: 'Edm.DateTimeOffset',
  timestamp: 'Edm.DateTimeOffset',
  timestamptz: 'Edm.DateTimeOffset',
  'timestamp without time zone': 'Edm.DateTimeOffset',
  'timestamp with time zone': 'Edm.DateTimeOffset',
  'timestamp with local time zone': 'Edm.DateTimeOffset',
  interval: 'Edm.Duration',

  // ── Двоичные ──────────────────────────────────────────────────────────────
  binary: 'Edm.Binary',
  varbinary: 'Edm.Binary',
  bytea: 'Edm.Binary',
  blob: 'Edm.Binary',
  tinyblob: 'Edm.Binary',
  mediumblob: 'Edm.Binary',
  longblob: 'Edm.Binary',
  image: 'Edm.Binary',
  raw: 'Edm.Binary',
};

/**
 * Типы EDM для колонок, объявленных без явного типа (`@Column()`).
 *
 * Ключ — имя функции-конструктора, которую TypeORM получил из `design:type`.
 * `Number` даёт `Edm.Int32`, потому что и сам TypeORM для такого поля создаёт целочисленную
 * колонку: дробное значение в неё не поместится независимо от того, что написано в TypeScript.
 */
const EDM_TYPE_BY_CONSTRUCTOR: Readonly<Record<string, string>> = {
  String: 'Edm.String',
  Number: 'Edm.Int32',
  Boolean: 'Edm.Boolean',
  Date: 'Edm.DateTimeOffset',
  Buffer: 'Edm.Binary',
};

/**
 * Подбирает тип EDM для колонки.
 *
 * Незнакомый тип приводится к {@link FALLBACK_EDM_TYPE}, а не отвергается ошибкой:
 * набор типов у каждой СУБД открыт (домены, расширения, пользовательские типы),
 * и падение генерации всего документа из-за одной экзотической колонки было бы хуже,
 * чем приблизительное описание одного поля. Точное соответствие для таких колонок
 * задаётся через опцию `edmType`.
 *
 * @param column - метаданные колонки TypeORM.
 * @returns имя примитивного типа EDM, например `'Edm.Int32'`.
 */
export function resolveEdmType(column: ColumnMetadata): string {
  const { type } = column;

  if (typeof type === 'function') {
    return EDM_TYPE_BY_CONSTRUCTOR[type.name] ?? FALLBACK_EDM_TYPE;
  }

  if (typeof type === 'string') {
    // Имя может прийти с уточнением длины — `varchar(255)`, `decimal(10, 2)`.
    // Скобки отсекаются: длина и точность описываются отдельными атрибутами CSDL.
    const normalized = type.toLowerCase().split('(')[0]?.trim() ?? '';

    return EDM_TYPE_BY_COLUMN_TYPE[normalized] ?? FALLBACK_EDM_TYPE;
  }

  return FALLBACK_EDM_TYPE;
}
