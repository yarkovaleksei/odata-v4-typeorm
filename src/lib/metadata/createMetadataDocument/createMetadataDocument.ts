/**
 * @file Генерация документа `$metadata` (CSDL XML) по метаданным TypeORM.
 *
 * ЗАЧЕМ ИМЕННО XML. Спецификация OData v4 определяет два представления модели: CSDL XML
 * и CSDL JSON, причём XML — обязательное, а JSON появился позже и необязателен. Клиенты
 * исходят из этого: `ra-data-odata-server`, `@odata/client`, Olingo и Excel запрашивают
 * `$metadata` и разбирают ответ как XML. Отдать им JSON — значит отдать документ, который
 * они не прочитают.
 *
 * ЧТО ОПИСЫВАЕТСЯ. Ровно то, что библиотека реально умеет отдавать по запросу:
 *
 * - свойства — `nonVirtualColumns` без скрытых `select: false`, то есть тот же список,
 *   который `executeQueryByQueryBuilder` кладёт в `SELECT` по умолчанию;
 * - связи — `metadata.relations`, то есть то, что доступно через `$expand`.
 *
 * Совпадение не случайное: документ, обещающий поле, которого запрос не вернёт, хуже
 * отсутствующего документа — клиент построит по нему форму и получит пустую колонку.
 *
 * ЧЕГО В ДОКУМЕНТЕ НЕТ. Колонки встроенных сущностей (`@Column(() => Name)`) пропускаются:
 * их путь свойства содержит точку (`name.first`), в CSDL такое поле описывается отдельным
 * `ComplexType`, а запросить его всё равно нельзя — путь `name/first` разбирается
 * посетителем как переход по связи, а не как обращение к составному свойству.
 * Пропускаются и сущности, чей первичный ключ ведёт через связь: набор без представимого
 * ключа не является корректным `EntitySet`.
 */
import type { DataSource, EntityMetadata } from 'typeorm';

import { resolveEdmType } from '../edmType';
import type { ColumnMetadata, MetadataDocumentOptions } from '../types';

/** Пространство имён обёртки EDMX. */
const EDMX_NAMESPACE = 'http://docs.oasis-open.org/odata/ns/edmx';

/** Пространство имён самой схемы EDM. */
const EDM_NAMESPACE = 'http://docs.oasis-open.org/odata/ns/edm';

/** Единица отступа. На разбор не влияет — документ читают и люди. */
const INDENT = '  ';

/** Типы EDM, для которых `MaxLength` имеет смысл. */
const TYPES_WITH_MAX_LENGTH = ['Edm.String', 'Edm.Binary'];

/** Типы EDM, для которых `Precision` имеет смысл. */
const TYPES_WITH_PRECISION = ['Edm.Decimal', 'Edm.DateTimeOffset', 'Edm.TimeOfDay', 'Edm.Duration'];

/**
 * Простой идентификатор CSDL.
 *
 * Спецификация (OData CSDL XML, раздел 4.1) требует: первый символ — буква или
 * подчёркивание, дальше до 127 букв, цифр и подчёркиваний. Ни пробелов, ни точек,
 * ни знаков препинания.
 */
const SIMPLE_IDENTIFIER = /^[\p{L}\p{Nl}_][\p{L}\p{Nl}\p{Nd}\p{Mn}\p{Mc}\p{Pc}\p{Cf}]{0,127}$/u;

/** Значение атрибута XML до экранирования. */
type AttributeValue = string | number | undefined;

/**
 * Проверяет, что имя пригодно как идентификатор CSDL.
 *
 * Имена приходят из настроек — `namespace`, `containerName` и результат `entitySetName`, —
 * то есть их пишет вызывающий код, а не библиотека. Без проверки строка с пробелом
 * или пустая строка молча уезжали бы в документ: XML остался бы корректным, а CSDL —
 * нет, и обнаружилось бы это уже у клиента, который отказался бы разбирать схему
 * целиком. См. `docs/audit.md`, дефект A-16.
 *
 * @throws {Error} если имя не является простым идентификатором CSDL.
 */
function assertSimpleIdentifier(value: string, what: string): void {
  if (!SIMPLE_IDENTIFIER.test(value)) {
    throw new Error(
      `${what} is not a valid CSDL identifier: ${JSON.stringify(value)}. ` +
        'Expected a letter or underscore followed by letters, digits or underscores.'
    );
  }
}

/**
 * Проверяет пространство имён: последовательность простых идентификаторов через точку.
 *
 * @throws {Error} если хотя бы одна часть непригодна.
 */
function assertNamespace(namespace: string): void {
  const parts = namespace.split('.');

  if (parts.length === 0 || parts.some((part) => !SIMPLE_IDENTIFIER.test(part))) {
    throw new Error(
      `namespace is not a valid CSDL namespace: ${JSON.stringify(namespace)}. ` +
        'Expected one or more dot-separated identifiers, for example "Shop" or "Shop.Catalog".'
    );
  }
}

/** Разобранные настройки плюс вычисленные по ним справочники. */
interface DocumentContext {
  namespace: string;
  includeHiddenColumns: boolean;
  edmType: MetadataDocumentOptions['edmType'];
  /** Имя `EntitySet` для каждой описываемой сущности. Заодно служит признаком «сущность в документе». */
  entitySetNames: Map<EntityMetadata, string>;
}

/**
 * Экранирует значение атрибута XML.
 *
 * Имена сущностей и колонок приходят из кода, а не от клиента, поэтому опасных символов
 * в них практически не бывает. Экранирование всё равно обязательно: пространство имён
 * и имена наборов задаются настройками, а невалидный XML сломает разбор целиком —
 * причём у клиента, а не здесь.
 */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Собирает строку атрибутов элемента.
 *
 * Пары со значением `undefined` пропускаются: в CSDL у большинства атрибутов есть значение
 * по умолчанию (`Nullable="true"`), и отсутствие атрибута — это и есть способ его выбрать.
 */
function formatAttributes(attributes: Record<string, AttributeValue>): string {
  return Object.entries(attributes)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ` ${key}="${escapeAttribute(String(value))}"`)
    .join('');
}

/** Отступ заданного уровня вложенности. */
function indent(level: number): string {
  return INDENT.repeat(level);
}

/**
 * Числовое значение атрибута длины/точности.
 *
 * TypeORM хранит длину строкой и для незаданной длины кладёт пустую строку, а не
 * `undefined` — поэтому простой проверки на `undefined` здесь недостаточно.
 */
function toPositiveInteger(value: string | number | undefined): number | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }

  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Можно ли описать колонку отдельным свойством CSDL.
 *
 * Точка в пути означает колонку встроенной сущности (`@Column(() => Name)`).
 * Имя свойства в CSDL — простой идентификатор, точки в нём недопустимы, а описать
 * такое поле честно (через `ComplexType`) нельзя: запросить его библиотека всё равно
 * не даст, см. заголовок файла.
 */
function isRepresentableColumn(column: ColumnMetadata): boolean {
  return !column.propertyPath.includes('.');
}

/**
 * Колонки, которые попадут в документ.
 *
 * Первичный ключ включается всегда, даже помеченный `select: false`: на него ссылается
 * элемент `Key`, и документ без соответствующего `Property` был бы невалиден. На практике
 * скрытых первичных ключей не бывает — имя ключа и так видно в каждом ответе.
 */
function selectableColumns(metadata: EntityMetadata, context: DocumentContext): ColumnMetadata[] {
  return metadata.nonVirtualColumns.filter(
    (column) =>
      isRepresentableColumn(column) &&
      (column.isSelect || column.isPrimary || context.includeHiddenColumns)
  );
}

/**
 * Пригодна ли сущность на роль набора сущностей OData.
 *
 * Отсеиваются три случая:
 *
 * 1. таблицы связи «многие ко многим» — TypeORM заводит для них метаданные, но
 *    самостоятельными сущностями они не являются;
 * 2. сущности без первичного ключа — `EntityType` обязан иметь `Key`;
 * 3. сущности, чей ключ ведёт через связь (`@PrimaryColumn` поверх `@ManyToOne`):
 *    путь такого ключа выглядит как `book.id`, и представить его `PropertyRef` нельзя.
 */
function isUsableEntity(metadata: EntityMetadata): boolean {
  return (
    !metadata.isJunction &&
    metadata.primaryColumns.length > 0 &&
    metadata.primaryColumns.every(isRepresentableColumn)
  );
}

/**
 * Метаданные сущностей, которые нужно описать.
 *
 * @throws {EntityMetadataNotFoundError} если в `entities` передана незарегистрированная сущность.
 */
function resolveEntities(
  dataSource: DataSource,
  entities: MetadataDocumentOptions['entities']
): EntityMetadata[] {
  const all = entities
    ? entities.map((entity) => dataSource.getMetadata(entity))
    : dataSource.entityMetadatas;

  // Повтор в списке — оплошность вызывающего кода (обычно склейка двух массивов
  // с пересечением). Описать сущность дважды невозможно ни в каком смысле: и тип,
  // и набор получили бы одинаковые имена, то есть документ стал бы невалидным.
  // Здесь нечего уточнять у пользователя, поэтому дубликаты просто схлопываются.
  return [...new Set(all)].filter(isUsableEntity);
}

/**
 * Сопоставляет каждой сущности имя её набора и проверяет получившиеся имена.
 *
 * Имя набора задаётся вызывающим кодом, и две сущности легко получают одно и то же —
 * например, если `entitySetName` обрезает или приводит имя к нижнему регистру.
 * В CSDL имена наборов внутри контейнера обязаны быть уникальны, а для клиента имя
 * набора — ещё и адрес: два набора под одним именем означают, что за одним URL стоят
 * две разные сущности, и какая из них ответит, зависит от того, какую клиент разобрал
 * последней. Такое расхождение обязано падать здесь, а не проявляться у клиента.
 *
 * @throws {Error} если имя непригодно как идентификатор CSDL либо повторяется.
 */
function resolveEntitySetNames(
  entities: EntityMetadata[],
  entitySetName: (metadata: EntityMetadata) => string
): Map<EntityMetadata, string> {
  const names = new Map<EntityMetadata, string>();
  const taken = new Map<string, string>();

  for (const metadata of entities) {
    const name = entitySetName(metadata);

    assertSimpleIdentifier(name, `entity set name for ${metadata.name}`);

    const owner = taken.get(name);

    if (owner !== undefined) {
      throw new Error(
        `entity set name ${JSON.stringify(name)} is used by both ${owner} and ${metadata.name}. ` +
          'Entity set names must be unique within a container.'
      );
    }

    taken.set(name, metadata.name);
    names.set(metadata, name);
  }

  return names;
}

/** Одно свойство `EntityType`. */
function buildProperty(column: ColumnMetadata, context: DocumentContext, level: number): string {
  const edmType = context.edmType?.(column) ?? resolveEdmType(column);

  // Массив на уровне колонки (`@Column({ array: true })` в PostgreSQL) в CSDL описывается
  // не отдельным типом, а обёрткой Collection() вокруг типа элемента.
  const type = column.isArray ? `Collection(${edmType})` : edmType;

  const maxLength = TYPES_WITH_MAX_LENGTH.includes(edmType)
    ? toPositiveInteger(column.length)
    : undefined;

  const precision = TYPES_WITH_PRECISION.includes(edmType)
    ? toPositiveInteger(column.precision ?? undefined)
    : undefined;

  // Scale отдельно от Precision: для Edm.Decimal нулевая шкала осмысленна (целое
  // с ограничением разрядности), поэтому проверка идёт на undefined, а не на истинность.
  const scale =
    edmType === 'Edm.Decimal' && column.scale !== undefined && column.scale >= 0
      ? column.scale
      : undefined;

  const attributes = formatAttributes({
    Name: column.propertyPath,
    Type: type,
    // Nullable="true" — значение CSDL по умолчанию, поэтому пишется только запрет.
    Nullable: column.isNullable ? undefined : 'false',
    MaxLength: maxLength,
    Precision: precision,
    Scale: scale,
  });

  return `${indent(level)}<Property${attributes}/>`;
}

/**
 * Одно свойство навигации `EntityType`.
 *
 * @returns строку элемента либо `undefined`, если связь описать нельзя: цель не входит
 *   в документ (её отсеял {@link isUsableEntity} или ограничил список `entities`),
 *   либо связь объявлена внутри встроенной сущности.
 */
function buildNavigationProperty(
  relation: EntityMetadata['relations'][number],
  context: DocumentContext,
  level: number
): string | undefined {
  if (relation.propertyPath.includes('.')) {
    return undefined;
  }

  const target = relation.inverseEntityMetadata;

  // Ссылка на тип, которого нет в документе, сделала бы схему невалидной: клиент
  // не смог бы разрешить `Default.Session` и, скорее всего, отверг бы документ целиком.
  if (!context.entitySetNames.has(target)) {
    return undefined;
  }

  const isCollection = relation.isOneToMany || relation.isManyToMany;
  const qualifiedType = `${context.namespace}.${target.name}`;

  // Partner связывает две стороны одной связи. Указывать его можно, только если обратная
  // сторона действительно объявлена в целевом типе: односторонний @ManyToOne без
  // @OneToMany на другом конце партнёра не имеет.
  const partner = relation.inverseRelation?.propertyPath;

  const attributes = formatAttributes({
    Name: relation.propertyPath,
    Type: isCollection ? `Collection(${qualifiedType})` : qualifiedType,
    // Nullable к коллекциям в CSDL неприменим: пустая коллекция — не то же самое,
    // что отсутствующее значение.
    Nullable: !isCollection && !relation.isNullable ? 'false' : undefined,
    Partner: partner !== undefined && !partner.includes('.') ? partner : undefined,
  });

  return `${indent(level)}<NavigationProperty${attributes}/>`;
}

/** Описание одного типа сущности. */
function buildEntityType(
  metadata: EntityMetadata,
  context: DocumentContext,
  level: number
): string[] {
  const lines: string[] = [];

  lines.push(`${indent(level)}<EntityType${formatAttributes({ Name: metadata.name })}>`);

  lines.push(`${indent(level + 1)}<Key>`);

  metadata.primaryColumns.forEach((column) => {
    lines.push(
      `${indent(level + 2)}<PropertyRef${formatAttributes({ Name: column.propertyPath })}/>`
    );
  });

  lines.push(`${indent(level + 1)}</Key>`);

  selectableColumns(metadata, context).forEach((column) => {
    lines.push(buildProperty(column, context, level + 1));
  });

  metadata.relations.forEach((relation) => {
    const line = buildNavigationProperty(relation, context, level + 1);

    if (line !== undefined) {
      lines.push(line);
    }
  });

  lines.push(`${indent(level)}</EntityType>`);

  return lines;
}

/**
 * Описание одного набора сущностей внутри контейнера.
 *
 * `NavigationPropertyBinding` сообщает клиенту, в каком наборе искать связанные сущности:
 * без него связь указывает на тип, но не на набор, и построить URL вида
 * `Authors(1)/books` клиент не сможет.
 */
function buildEntitySet(
  metadata: EntityMetadata,
  context: DocumentContext,
  level: number
): string[] {
  const name = context.entitySetNames.get(metadata) as string;

  const bindings = metadata.relations
    .filter((relation) => !relation.propertyPath.includes('.'))
    .map((relation) => ({
      relation,
      target: context.entitySetNames.get(relation.inverseEntityMetadata),
    }))
    .filter((binding): binding is { relation: typeof binding.relation; target: string } =>
      Boolean(binding.target)
    );

  const attributes = formatAttributes({
    Name: name,
    EntityType: `${context.namespace}.${metadata.name}`,
  });

  if (bindings.length === 0) {
    return [`${indent(level)}<EntitySet${attributes}/>`];
  }

  const lines = [`${indent(level)}<EntitySet${attributes}>`];

  bindings.forEach(({ relation, target }) => {
    lines.push(
      `${indent(level + 1)}<NavigationPropertyBinding${formatAttributes({
        Path: relation.propertyPath,
        Target: target,
      })}/>`
    );
  });

  lines.push(`${indent(level)}</EntitySet>`);

  return lines;
}

/**
 * Строит документ `$metadata` (CSDL XML) по сущностям, зарегистрированным в `DataSource`.
 *
 * @param dataSource - инициализированный источник данных TypeORM.
 * @param options - пространство имён, отбор сущностей, именование наборов и переопределение
 *   типов EDM. См. {@link MetadataDocumentOptions}.
 * @returns документ CSDL XML целиком, вместе с объявлением `<?xml …?>`.
 *
 * @throws {Error} если `DataSource` не инициализирован. Проверка обязательна: до вызова
 *   `initialize()` список `entityMetadatas` пуст, и молча вернулся бы синтаксически
 *   корректный, но пустой документ — клиент решил бы, что сервис не отдаёт ни одного
 *   ресурса, и никакой ошибки при этом не увидел бы.
 * @throws {EntityMetadataNotFoundError} если в `entities` передана незарегистрированная сущность.
 *
 * @example
 * app.get('/api/$metadata', (_req, res) => {
 *   res.type('application/xml').send(createMetadataDocument(dataSource));
 * });
 *
 * @example
 * // Публичное API: перечислять сущности явно, имена наборов — под маршруты.
 * createMetadataDocument(dataSource, {
 *   namespace: 'Shop',
 *   entities: [Author, Book],
 *   entitySetName: (metadata) => metadata.tableName,
 * });
 */
export function createMetadataDocument(
  dataSource: DataSource,
  options: MetadataDocumentOptions = {}
): string {
  if (!dataSource.isInitialized) {
    throw new Error(
      'DataSource is not initialized: call initialize() before building the $metadata document.'
    );
  }

  const {
    namespace = 'Default',
    containerName = 'Container',
    entitySetName = (metadata: EntityMetadata) => metadata.name,
    includeHiddenColumns = false,
    edmType,
  } = options;

  // Имена проверяются до обхода сущностей: незачем строить документ, который заведомо
  // не будет разобран клиентом.
  assertNamespace(namespace);
  assertSimpleIdentifier(containerName, 'containerName');

  const entities = resolveEntities(dataSource, options.entities);

  const context: DocumentContext = {
    namespace,
    includeHiddenColumns,
    edmType,
    entitySetNames: resolveEntitySetNames(entities, entitySetName),
  };

  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];

  lines.push(`<edmx:Edmx xmlns:edmx="${EDMX_NAMESPACE}" Version="4.0">`);
  lines.push(`${indent(1)}<edmx:DataServices>`);
  lines.push(
    `${indent(2)}<Schema xmlns="${EDM_NAMESPACE}"${formatAttributes({ Namespace: namespace })}>`
  );

  // Порядок обязателен: по схеме CSDL объявления типов идут до контейнера сущностей.
  entities.forEach((metadata) => {
    lines.push(...buildEntityType(metadata, context, 3));
  });

  lines.push(`${indent(3)}<EntityContainer${formatAttributes({ Name: containerName })}>`);

  entities.forEach((metadata) => {
    lines.push(...buildEntitySet(metadata, context, 4));
  });

  lines.push(`${indent(3)}</EntityContainer>`);
  lines.push(`${indent(2)}</Schema>`);
  lines.push(`${indent(1)}</edmx:DataServices>`);
  lines.push('</edmx:Edmx>');

  return `${lines.join('\n')}\n`;
}
