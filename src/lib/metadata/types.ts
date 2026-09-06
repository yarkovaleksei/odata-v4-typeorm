/**
 * @file Типы слоя `$metadata`: настройки генерации CSDL-документа.
 */
import type { EntityMetadata, EntityTarget, ObjectLiteral } from 'typeorm';

/**
 * Метаданные одной колонки.
 *
 * Тип выводится из `EntityMetadata`, а не импортируется по пути
 * `typeorm/metadata/ColumnMetadata`: карта `exports` в TypeORM не публикует внутренние
 * модули, и такой импорт не разрешается.
 */
export type ColumnMetadata = EntityMetadata['columns'][number];

/** Настройки генерации документа CSDL. */
export interface MetadataDocumentOptions {
  /**
   * Пространство имён схемы. Им же квалифицируются ссылки на типы внутри документа:
   * `EntitySet EntityType="Default.Author"`.
   *
   * Клиенты используют его как префикс имён типов, поэтому менять его после публикации
   * API — ломающее изменение.
   *
   * @defaultValue `'Default'`
   */
  namespace?: string;

  /**
   * Имя контейнера сущностей (`EntityContainer`).
   *
   * @defaultValue `'Container'`
   */
  containerName?: string;

  /**
   * Какие сущности описывать. По умолчанию — все, зарегистрированные в `DataSource`.
   *
   * Задавайте явно для публичного API: документ `$metadata` перечисляет имена всех полей
   * и связей, то есть раскрывает схему БД целиком. Служебным сущностям (сессии, аудит,
   * очереди) там делать нечего.
   *
   * @throws {EntityMetadataNotFoundError} если сущность не зарегистрирована в `DataSource`.
   */
  entities?: ReadonlyArray<EntityTarget<ObjectLiteral>>;

  /**
   * Имя набора сущностей (`EntitySet`) — то, под каким именем ресурс виден клиенту.
   *
   * Для потребителей вроде `ra-data-odata-server` это имя становится именем ресурса
   * react-admin И сегментом URL, по которому он ходит за данными. Поэтому оно должно
   * совпадать с маршрутом, на который вы повесили `ODataQueryMiddleware`.
   *
   * По умолчанию берётся имя класса сущности (`Author`) — та же величина, что служит
   * `alias` в остальной библиотеке. Множественное число намеренно не образуется:
   * правила английской морфологии в общем случае не выводятся, и угаданное `Personss`
   * молча разошлось бы с реальным маршрутом.
   *
   * @defaultValue `(metadata) => metadata.name`
   *
   * @example
   * // маршруты вида /api/authors
   * entitySetName: (metadata) => metadata.tableName,
   */
  entitySetName?: (metadata: EntityMetadata) => string;

  /**
   * Описывать ли колонки, помеченные `@Column({ select: false })`.
   *
   * По умолчанию `false`, и это согласовано с поведением запросов: такие колонки
   * библиотека не возвращает ни по одному пути и отвергает обращения к ним из `$select`,
   * `$filter` и `$orderby` (см. `docs/audit.md`, дефект A-12). Описать в `$metadata` поле,
   * которое нельзя ни выбрать, ни отфильтровать, значит соврать клиенту — и заодно
   * подсказать имя скрытой колонки.
   *
   * @defaultValue `false`
   */
  includeHiddenColumns?: boolean;

  /**
   * Переопределение типа EDM для отдельных колонок.
   *
   * Возврат `undefined` означает «решай по умолчанию». Нужен для типов, специфичных
   * для конкретной СУБД (`ltree`, `hstore`, `geometry`, пользовательские домены),
   * которые встроенная таблица соответствий не знает и приводит к `Edm.String`.
   *
   * @example
   * edmType: (column) => (column.type === 'geometry' ? 'Edm.GeographyPoint' : undefined),
   */
  edmType?: (column: ColumnMetadata) => string | undefined;
}
