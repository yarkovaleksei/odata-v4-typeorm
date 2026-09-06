/**
 * @file Тесты генерации документа `$metadata`.
 *
 * Документ проверяется двумя способами, и оба нужны.
 *
 * 1. **Разбором настоящим XML-парсером.** Строковые проверки подтверждают, что нужная
 *    подстрока есть, но не то, что документ вообще читается: пропущенная закрывающая скобка
 *    их не ломает. Здесь берётся `fast-xml-parser` с теми же настройками, что у
 *    `ra-data-odata-server` (`attributeNamePrefix: '_'`, `removeNSPrefix: true`), —
 *    то есть документ читается ровно тем инструментом, ради которого он и существует.
 * 2. **Сверкой одного документа целиком.** Разбор не замечает отступов, порядка элементов
 *    и лишних объявлений; для маленькой схемы дешевле сравнить строку с образцом.
 *
 * ПРО ИСТОЧНИК ДАННЫХ. Тесты не используют общий `dataSource` из `test/setup`, а поднимают
 * свой на SQLite. Генерация схемы не обращается к базе вовсе — она работает по метаданным
 * TypeORM, — поэтому прогонять её на трёх СУБД смысла нет, а вот тип колонки от диалекта
 * зависит (`datetime` против `timestamp`), и проверки перестали бы быть однозначными.
 */
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import {
  Column,
  DataSource,
  Entity,
  JoinTable,
  ManyToMany,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  ViewColumn,
  ViewEntity,
} from 'typeorm';

import { createMetadataDocument } from './createMetadataDocument';

@Entity()
class Catalog {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 120 })
  title!: string;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  price!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'datetime' })
  createdAt!: Date;

  /** Проверяет, что скрытые колонки в схему не попадают (см. дефект A-12). */
  @Column({ select: false })
  internalNote!: string;

  @OneToMany(() => CatalogItem, (item) => item.catalog)
  items!: CatalogItem[];

  @ManyToMany(() => Tag, (tag) => tag.catalogs)
  @JoinTable()
  tags!: Tag[];
}

@Entity()
class CatalogItem {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  /** `nullable: false` — единственная связь, у которой в схеме должен быть `Nullable="false"`. */
  @ManyToOne(() => Catalog, (catalog) => catalog.items, { nullable: false })
  catalog!: Catalog;
}

@Entity()
class Tag {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  label!: string;

  @ManyToMany(() => Catalog, (catalog) => catalog.tags)
  catalogs!: Catalog[];
}

/** Представление без первичного ключа: корректным `EntitySet` быть не может. */
@ViewEntity({ expression: 'SELECT id, title FROM catalog' })
class CatalogSummary {
  @ViewColumn()
  id!: number;

  @ViewColumn()
  title!: string;
}

// ── Разбор документа ────────────────────────────────────────────────────────

interface ParsedProperty {
  _Name: string;
  _Type: string;
  _Nullable?: string;
  _MaxLength?: string;
  _Precision?: string;
  _Scale?: string;
}

interface ParsedNavigationProperty {
  _Name: string;
  _Type: string;
  _Nullable?: string;
  _Partner?: string;
}

interface ParsedEntityType {
  _Name: string;
  Key?: { PropertyRef: { _Name: string }[] };
  Property?: ParsedProperty[];
  NavigationProperty?: ParsedNavigationProperty[];
}

interface ParsedEntitySet {
  _Name: string;
  _EntityType: string;
  NavigationPropertyBinding?: { _Path: string; _Target: string }[];
}

interface ParsedSchema {
  _Namespace: string;
  EntityType?: ParsedEntityType[];
  EntityContainer: { _Name: string; EntitySet?: ParsedEntitySet[] };
}

interface ParsedDocument {
  Edmx: { _Version: string; DataServices: { Schema: ParsedSchema[] } };
}

/**
 * Парсер с настройками `ra-data-odata-server`.
 *
 * `removeNSPrefix` снимает префиксы пространств имён (`edmx:Edmx` → `Edmx`), поэтому
 * обращение идёт по коротким именам. `isArray` перечисляет элементы, которых может быть
 * несколько: без него единственный `EntityType` пришёл бы объектом, а не массивом из одного.
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '_',
  removeNSPrefix: true,
  isArray: (name) =>
    [
      'Schema',
      'EntityType',
      'EntitySet',
      'Property',
      'NavigationProperty',
      'PropertyRef',
      'NavigationPropertyBinding',
    ].includes(name),
});

function parseSchema(xml: string): ParsedSchema {
  expect(XMLValidator.validate(xml)).toBe(true);

  const parsed = parser.parse(xml) as ParsedDocument;
  const schema = parsed.Edmx.DataServices.Schema[0];

  if (!schema) {
    throw new Error('в документе нет ни одной схемы');
  }

  return schema;
}

function entityTypeNamed(schema: ParsedSchema, name: string): ParsedEntityType {
  const found = schema.EntityType?.find((type) => type._Name === name);

  if (!found) {
    throw new Error(`тип ${name} не найден в схеме`);
  }

  return found;
}

function propertyNamed(type: ParsedEntityType, name: string): ParsedProperty {
  const found = type.Property?.find((property) => property._Name === name);

  if (!found) {
    throw new Error(`свойство ${name} не найдено в типе ${type._Name}`);
  }

  return found;
}

function navigationNamed(type: ParsedEntityType, name: string): ParsedNavigationProperty {
  const found = type.NavigationProperty?.find((navigation) => navigation._Name === name);

  if (!found) {
    throw new Error(`связь ${name} не найдена в типе ${type._Name}`);
  }

  return found;
}

// ── Тесты ───────────────────────────────────────────────────────────────────

describe('createMetadataDocument', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      // Схема в базе не нужна: документ строится по метаданным TypeORM, а представление
      // ссылается на таблицу, которой при synchronize: false никто не создаёт.
      synchronize: false,
      entities: [Catalog, CatalogItem, Tag, CatalogSummary],
      logging: false,
    });

    await dataSource.initialize();
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  describe('оболочка документа', () => {
    it('документ целиком соответствует образцу', () => {
      // Маленькая схема из одной сущности: сверять построчно можно только такую.
      // Заодно проверяется, что связь `catalogs` выброшена — её цель не входит в документ.
      expect(createMetadataDocument(dataSource, { entities: [Tag] })).toBe(
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx" Version="4.0">',
          '  <edmx:DataServices>',
          '    <Schema xmlns="http://docs.oasis-open.org/odata/ns/edm" Namespace="Default">',
          '      <EntityType Name="Tag">',
          '        <Key>',
          '          <PropertyRef Name="id"/>',
          '        </Key>',
          '        <Property Name="id" Type="Edm.Int32" Nullable="false"/>',
          '        <Property Name="label" Type="Edm.String" Nullable="false"/>',
          '      </EntityType>',
          '      <EntityContainer Name="Container">',
          '        <EntitySet Name="Tag" EntityType="Default.Tag"/>',
          '      </EntityContainer>',
          '    </Schema>',
          '  </edmx:DataServices>',
          '</edmx:Edmx>',
          '',
        ].join('\n')
      );
    });

    it('версия протокола объявлена', () => {
      const parsed = parser.parse(createMetadataDocument(dataSource)) as ParsedDocument;

      expect(parsed.Edmx._Version).toBe('4.0');
    });

    it('пространство имён и имя контейнера настраиваются', () => {
      const schema = parseSchema(
        createMetadataDocument(dataSource, { namespace: 'Shop', containerName: 'Api' })
      );

      expect(schema._Namespace).toBe('Shop');
      expect(schema.EntityContainer._Name).toBe('Api');
      // Ссылки на типы обязаны переехать вместе с пространством имён, иначе клиент
      // не разрешит `Default.Catalog` в схеме с namespace `Shop`.
      expect(entityTypeNamed(schema, 'CatalogItem').NavigationProperty?.[0]?._Type).toBe(
        'Shop.Catalog'
      );
    });

    it('спецсимволы в настройках экранируются', () => {
      const xml = createMetadataDocument(dataSource, {
        entities: [Tag],
        namespace: 'A&B"C',
      });

      expect(XMLValidator.validate(xml)).toBe(true);
      expect(xml).toContain('Namespace="A&amp;B&quot;C"');
    });
  });

  describe('свойства', () => {
    it('ключ описан элементом Key', () => {
      const schema = parseSchema(createMetadataDocument(dataSource));

      expect(entityTypeNamed(schema, 'Catalog').Key?.PropertyRef).toEqual([{ _Name: 'id' }]);
    });

    it.each([
      ['id', 'Edm.Int32'],
      ['title', 'Edm.String'],
      ['price', 'Edm.Decimal'],
      ['description', 'Edm.String'],
      ['createdAt', 'Edm.DateTimeOffset'],
    ])('%s имеет тип %s', (name, expected) => {
      const schema = parseSchema(createMetadataDocument(dataSource));

      expect(propertyNamed(entityTypeNamed(schema, 'Catalog'), name)._Type).toBe(expected);
    });

    it('обязательность колонки отражена в Nullable', () => {
      const catalog = entityTypeNamed(parseSchema(createMetadataDocument(dataSource)), 'Catalog');

      expect(propertyNamed(catalog, 'title')._Nullable).toBe('false');
      // Nullable="true" — значение CSDL по умолчанию, поэтому атрибута быть не должно.
      expect(propertyNamed(catalog, 'description')._Nullable).toBeUndefined();
    });

    it('длина и точность переносятся в атрибуты CSDL', () => {
      const catalog = entityTypeNamed(parseSchema(createMetadataDocument(dataSource)), 'Catalog');

      expect(propertyNamed(catalog, 'title')._MaxLength).toBe('120');
      expect(propertyNamed(catalog, 'price')._Precision).toBe('10');
      expect(propertyNamed(catalog, 'price')._Scale).toBe('2');
      // MaxLength осмыслен только для строк и двоичных данных.
      expect(propertyNamed(catalog, 'createdAt')._MaxLength).toBeUndefined();
    });

    it('тип EDM переопределяется опцией edmType', () => {
      const schema = parseSchema(
        createMetadataDocument(dataSource, {
          edmType: (column) => (column.propertyName === 'price' ? 'Edm.Double' : undefined),
        })
      );

      const catalog = entityTypeNamed(schema, 'Catalog');

      expect(propertyNamed(catalog, 'price')._Type).toBe('Edm.Double');
      // Возврат undefined означает «решай по умолчанию» — остальные колонки не задеты.
      expect(propertyNamed(catalog, 'title')._Type).toBe('Edm.String');
    });
  });

  describe('скрытые колонки', () => {
    it('колонка select: false в схему не попадает', () => {
      const catalog = entityTypeNamed(parseSchema(createMetadataDocument(dataSource)), 'Catalog');

      // Описать поле, которое библиотека не вернёт и запретит фильтровать, значит соврать
      // клиенту — и подсказать имя скрытой колонки. См. дефект A-12.
      expect(catalog.Property?.map((property) => property._Name)).not.toContain('internalNote');
    });

    it('includeHiddenColumns возвращает её в схему', () => {
      const schema = parseSchema(
        createMetadataDocument(dataSource, { includeHiddenColumns: true })
      );

      expect(propertyNamed(entityTypeNamed(schema, 'Catalog'), 'internalNote')._Type).toBe(
        'Edm.String'
      );
    });
  });

  describe('связи', () => {
    it('связь «ко многим» описана как коллекция', () => {
      const catalog = entityTypeNamed(parseSchema(createMetadataDocument(dataSource)), 'Catalog');

      expect(navigationNamed(catalog, 'items')._Type).toBe('Collection(Default.CatalogItem)');
      expect(navigationNamed(catalog, 'tags')._Type).toBe('Collection(Default.Tag)');
    });

    it('связь «к одному» описана типом сущности', () => {
      const item = entityTypeNamed(parseSchema(createMetadataDocument(dataSource)), 'CatalogItem');

      expect(navigationNamed(item, 'catalog')._Type).toBe('Default.Catalog');
    });

    it('обе стороны связи указывают друг на друга через Partner', () => {
      const schema = parseSchema(createMetadataDocument(dataSource));

      expect(navigationNamed(entityTypeNamed(schema, 'Catalog'), 'items')._Partner).toBe('catalog');
      expect(navigationNamed(entityTypeNamed(schema, 'CatalogItem'), 'catalog')._Partner).toBe(
        'items'
      );
    });

    it('обязательность связи «к одному» отражена в Nullable', () => {
      const schema = parseSchema(createMetadataDocument(dataSource));

      expect(navigationNamed(entityTypeNamed(schema, 'CatalogItem'), 'catalog')._Nullable).toBe(
        'false'
      );
      // К коллекции Nullable в CSDL неприменим: пустая коллекция — не отсутствующее значение.
      expect(
        navigationNamed(entityTypeNamed(schema, 'Catalog'), 'items')._Nullable
      ).toBeUndefined();
    });

    it('связь на сущность вне документа выбрасывается', () => {
      // Ссылка на необъявленный тип сделала бы схему невалидной: клиент не смог бы
      // разрешить `Default.Catalog` и, скорее всего, отверг бы документ целиком.
      const schema = parseSchema(createMetadataDocument(dataSource, { entities: [Tag] }));

      expect(entityTypeNamed(schema, 'Tag').NavigationProperty).toBeUndefined();
    });
  });

  describe('контейнер сущностей', () => {
    it('набор объявлен для каждой описанной сущности', () => {
      const schema = parseSchema(createMetadataDocument(dataSource));

      expect(schema.EntityContainer.EntitySet?.map((set) => set._Name).sort()).toEqual([
        'Catalog',
        'CatalogItem',
        'Tag',
      ]);
    });

    it('набор ссылается на тип по полному имени', () => {
      const schema = parseSchema(createMetadataDocument(dataSource));
      const set = schema.EntityContainer.EntitySet?.find((item) => item._Name === 'Catalog');

      expect(set?._EntityType).toBe('Default.Catalog');
    });

    it('связи привязаны к наборам через NavigationPropertyBinding', () => {
      const schema = parseSchema(createMetadataDocument(dataSource));
      const set = schema.EntityContainer.EntitySet?.find((item) => item._Name === 'Catalog');

      // Без привязки клиент знает тип связанной сущности, но не набор, и не построит
      // адрес вида `Catalog(1)/items`.
      expect(set?.NavigationPropertyBinding).toEqual([
        { _Path: 'items', _Target: 'CatalogItem' },
        { _Path: 'tags', _Target: 'Tag' },
      ]);
    });

    it('имя набора задаётся опцией entitySetName', () => {
      const schema = parseSchema(
        createMetadataDocument(dataSource, {
          entitySetName: (metadata) => metadata.tableName,
        })
      );

      expect(schema.EntityContainer.EntitySet?.map((set) => set._Name).sort()).toEqual([
        'catalog',
        'catalog_item',
        'tag',
      ]);
      // Привязки обязаны использовать новые имена, иначе клиент пойдёт по несуществующему адресу.
      const set = schema.EntityContainer.EntitySet?.find((item) => item._Name === 'catalog');

      expect(set?.NavigationPropertyBinding).toEqual([
        { _Path: 'items', _Target: 'catalog_item' },
        { _Path: 'tags', _Target: 'tag' },
      ]);
    });
  });

  describe('что в документ не попадает', () => {
    it('таблица связи «многие ко многим» не становится набором', () => {
      const schema = parseSchema(createMetadataDocument(dataSource));

      // TypeORM заводит метаданные для таблицы связи, но самостоятельной сущностью
      // она не является и в модели OData ей соответствует не набор, а сама связь.
      expect(schema.EntityType?.map((type) => type._Name)).not.toContain('catalog_tags_tag');
    });

    it('сущность без первичного ключа не становится набором', () => {
      const schema = parseSchema(createMetadataDocument(dataSource));

      // `EntityType` обязан иметь `Key`; представление без ключа описать нечем.
      expect(schema.EntityType?.map((type) => type._Name)).not.toContain('CatalogSummary');
    });

    it('колонка внешнего ключа не дублирует связь', () => {
      const item = entityTypeNamed(parseSchema(createMetadataDocument(dataSource)), 'CatalogItem');

      // TypeORM держит `catalogId` отдельной колонкой, но библиотека её не выбирает
      // (она виртуальная), а в модели OData за неё отвечает NavigationProperty.
      expect(item.Property?.map((property) => property._Name)).toEqual(['id', 'name']);
    });
  });

  describe('ошибки', () => {
    it('неинициализированный DataSource отвергается', async () => {
      const idle = new DataSource({
        type: 'sqlite',
        database: ':memory:',
        entities: [Tag],
      });

      // Молча вернуть пустой документ нельзя: он синтаксически корректен, и клиент
      // решил бы, что сервис не отдаёт ни одного ресурса, не увидев никакой ошибки.
      expect(() => createMetadataDocument(idle)).toThrow(/not initialized/);
    });

    it('незарегистрированная сущность отвергается', () => {
      class Unknown {}

      expect(() => createMetadataDocument(dataSource, { entities: [Unknown] })).toThrow();
    });
  });
});
