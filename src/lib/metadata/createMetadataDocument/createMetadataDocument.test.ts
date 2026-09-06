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
 * Схема — общая для всех тестов и демо-сервера (см. `src/test/fixtures/`), поэтому здесь
 * не заводится ни одной сущности «под тест»: всё, что нужно проверить, в ней уже есть —
 * скрытая колонка, обязательная связь, связь «многие ко многим» и представление без ключа.
 */
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { DataSource } from 'typeorm';

import { Tag } from '../../../test/fixtures';
import { buildDataSourceOptions, dataSource } from '../../../test/setup/dataSource';
import { createMetadataDocument } from './createMetadataDocument';

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

function entitySetNamed(schema: ParsedSchema, name: string): ParsedEntitySet {
  const found = schema.EntityContainer.EntitySet?.find((set) => set._Name === name);

  if (!found) {
    throw new Error(`набор ${name} не найден в контейнере`);
  }

  return found;
}

/** Сущности, которые обязаны стать наборами. Без представления и без таблицы связи. */
const PUBLISHABLE_ENTITIES = [
  'Author',
  'Book',
  'BookDetails',
  'Category',
  'Post',
  'Publisher',
  'Review',
  'Tag',
  'User',
];

// ── Тесты ───────────────────────────────────────────────────────────────────

describe('createMetadataDocument', () => {
  describe('оболочка документа', () => {
    it('документ целиком соответствует образцу', () => {
      // Маленькая схема из одной сущности: сверять построчно можно только такую.
      // Заодно проверяется, что связь `books` выброшена — её цель не входит в документ.
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
      // не разрешит `Default.Book` в схеме с namespace `Shop`.
      expect(navigationNamed(entityTypeNamed(schema, 'Book'), 'author')._Type).toBe('Shop.Author');
    });

    it('спецсимволы в настройках экранируются', () => {
      const xml = createMetadataDocument(dataSource, { entities: [Tag], namespace: 'A&B"C' });

      expect(XMLValidator.validate(xml)).toBe(true);
      expect(xml).toContain('Namespace="A&amp;B&quot;C"');
    });
  });

  describe('свойства', () => {
    it('ключ описан элементом Key', () => {
      const schema = parseSchema(createMetadataDocument(dataSource));

      expect(entityTypeNamed(schema, 'Author').Key?.PropertyRef).toEqual([{ _Name: 'id' }]);
    });

    it.each([
      ['Author', 'id', 'Edm.Int32'],
      ['Author', 'name', 'Edm.String'],
      ['Author', 'age', 'Edm.Int32'],
      ['Author', 'rating', 'Edm.Double'],
      ['Author', 'registeredAt', 'Edm.DateTimeOffset'],
      ['Author', 'bio', 'Edm.String'],
      ['Publisher', 'royaltyRate', 'Edm.Decimal'],
      ['Publisher', 'foundedOn', 'Edm.Date'],
      ['BookDetails', 'releaseTime', 'Edm.TimeOfDay'],
    ])('%s.%s имеет тип %s', (entity, property, expected) => {
      const schema = parseSchema(createMetadataDocument(dataSource));

      expect(propertyNamed(entityTypeNamed(schema, entity), property)._Type).toBe(expected);
    });

    it('обязательность колонки отражена в Nullable', () => {
      const author = entityTypeNamed(parseSchema(createMetadataDocument(dataSource)), 'Author');

      expect(propertyNamed(author, 'name')._Nullable).toBe('false');
      // Nullable="true" — значение CSDL по умолчанию, поэтому атрибута быть не должно.
      expect(propertyNamed(author, 'bio')._Nullable).toBeUndefined();
    });

    it('длина и точность переносятся в атрибуты CSDL', () => {
      const schema = parseSchema(createMetadataDocument(dataSource));
      const publisher = entityTypeNamed(schema, 'Publisher');

      expect(propertyNamed(publisher, 'name')._MaxLength).toBe('120');
      expect(propertyNamed(publisher, 'country')._MaxLength).toBe('2');
      expect(propertyNamed(publisher, 'royaltyRate')._Precision).toBe('10');
      expect(propertyNamed(publisher, 'royaltyRate')._Scale).toBe('2');
      // MaxLength осмыслен только для строк и двоичных данных.
      expect(propertyNamed(publisher, 'foundedOn')._MaxLength).toBeUndefined();
    });

    it('тип EDM переопределяется опцией edmType', () => {
      const schema = parseSchema(
        createMetadataDocument(dataSource, {
          edmType: (column) => (column.propertyName === 'royaltyRate' ? 'Edm.Double' : undefined),
        })
      );

      const publisher = entityTypeNamed(schema, 'Publisher');

      expect(propertyNamed(publisher, 'royaltyRate')._Type).toBe('Edm.Double');
      // Возврат undefined означает «решай по умолчанию» — остальные колонки не задеты.
      expect(propertyNamed(publisher, 'name')._Type).toBe('Edm.String');
    });
  });

  describe('скрытые колонки', () => {
    it('колонка select: false в схему не попадает', () => {
      const user = entityTypeNamed(parseSchema(createMetadataDocument(dataSource)), 'User');

      // Описать поле, которое библиотека не вернёт и запретит фильтровать, значит соврать
      // клиенту — и подсказать имя скрытой колонки. См. дефект A-12.
      expect(user.Property?.map((property) => property._Name)).toEqual(['id', 'name', 'email']);
    });

    it('includeHiddenColumns возвращает её в схему', () => {
      const schema = parseSchema(
        createMetadataDocument(dataSource, { includeHiddenColumns: true })
      );

      expect(propertyNamed(entityTypeNamed(schema, 'User'), 'passwordHash')._Type).toBe(
        'Edm.String'
      );
    });
  });

  describe('связи', () => {
    it('связь «ко многим» описана как коллекция', () => {
      const schema = parseSchema(createMetadataDocument(dataSource));

      expect(navigationNamed(entityTypeNamed(schema, 'Author'), 'books')._Type).toBe(
        'Collection(Default.Book)'
      );
      expect(navigationNamed(entityTypeNamed(schema, 'Book'), 'tags')._Type).toBe(
        'Collection(Default.Tag)'
      );
    });

    it('связи «к одному» и «один к одному» описаны типом сущности', () => {
      const book = entityTypeNamed(parseSchema(createMetadataDocument(dataSource)), 'Book');

      expect(navigationNamed(book, 'author')._Type).toBe('Default.Author');
      expect(navigationNamed(book, 'details')._Type).toBe('Default.BookDetails');
    });

    it('обе стороны связи указывают друг на друга через Partner', () => {
      const schema = parseSchema(createMetadataDocument(dataSource));

      expect(navigationNamed(entityTypeNamed(schema, 'Author'), 'books')._Partner).toBe('author');
      expect(navigationNamed(entityTypeNamed(schema, 'Book'), 'author')._Partner).toBe('books');
    });

    it('ссылка на саму себя описывается как обычная связь', () => {
      const category = entityTypeNamed(parseSchema(createMetadataDocument(dataSource)), 'Category');

      expect(navigationNamed(category, 'parent')._Type).toBe('Default.Category');
      expect(navigationNamed(category, 'children')._Type).toBe('Collection(Default.Category)');
    });

    it('обязательность связи «к одному» отражена в Nullable', () => {
      const book = entityTypeNamed(parseSchema(createMetadataDocument(dataSource)), 'Book');

      // publisher объявлен nullable: false — единственная обязательная связь в схеме.
      expect(navigationNamed(book, 'publisher')._Nullable).toBe('false');
      expect(navigationNamed(book, 'author')._Nullable).toBeUndefined();
      // К коллекции Nullable в CSDL неприменим: пустая коллекция — не отсутствующее значение.
      expect(navigationNamed(book, 'reviews')._Nullable).toBeUndefined();
    });

    it('связь на сущность вне документа выбрасывается', () => {
      // Ссылка на необъявленный тип сделала бы схему невалидной: клиент не смог бы
      // разрешить `Default.Book` и, скорее всего, отверг бы документ целиком.
      const schema = parseSchema(createMetadataDocument(dataSource, { entities: [Tag] }));

      expect(entityTypeNamed(schema, 'Tag').NavigationProperty).toBeUndefined();
    });
  });

  describe('контейнер сущностей', () => {
    it('набор объявлен для каждой описанной сущности', () => {
      const schema = parseSchema(createMetadataDocument(dataSource));

      expect(schema.EntityContainer.EntitySet?.map((set) => set._Name).sort()).toEqual(
        PUBLISHABLE_ENTITIES
      );
    });

    it('набор ссылается на тип по полному имени', () => {
      const schema = parseSchema(createMetadataDocument(dataSource));

      expect(entitySetNamed(schema, 'Book')._EntityType).toBe('Default.Book');
    });

    it('связи привязаны к наборам через NavigationPropertyBinding', () => {
      const schema = parseSchema(createMetadataDocument(dataSource));

      // Без привязки клиент знает тип связанной сущности, но не набор, и не построит
      // адрес вида `Book(1)/reviews`.
      expect(entitySetNamed(schema, 'Book').NavigationPropertyBinding).toEqual([
        { _Path: 'author', _Target: 'Author' },
        { _Path: 'publisher', _Target: 'Publisher' },
        { _Path: 'category', _Target: 'Category' },
        { _Path: 'reviews', _Target: 'Review' },
        { _Path: 'tags', _Target: 'Tag' },
        { _Path: 'details', _Target: 'BookDetails' },
      ]);
    });

    it('имя набора задаётся опцией entitySetName', () => {
      const schema = parseSchema(
        createMetadataDocument(dataSource, { entitySetName: (metadata) => metadata.tableName })
      );

      expect(schema.EntityContainer.EntitySet?.map((set) => set._Name).sort()).toEqual([
        'app_user',
        'author',
        'book',
        'book_details',
        'category',
        'post',
        'publisher',
        'review',
        'tag',
      ]);
      // Привязки обязаны использовать новые имена, иначе клиент пойдёт по несуществующему адресу.
      expect(entitySetNamed(schema, 'review').NavigationPropertyBinding).toEqual([
        { _Path: 'book', _Target: 'book' },
        { _Path: 'user', _Target: 'app_user' },
      ]);
    });
  });

  describe('что в документ не попадает', () => {
    it('таблица связи «многие ко многим» не становится набором', () => {
      const schema = parseSchema(createMetadataDocument(dataSource));

      // TypeORM заводит метаданные для таблицы связи, но самостоятельной сущностью
      // она не является и в модели OData ей соответствует не набор, а сама связь.
      // Порядок типов повторяет порядок метаданных в TypeORM и ничего не значит.
      expect(schema.EntityType?.map((type) => type._Name).sort()).toEqual(PUBLISHABLE_ENTITIES);
      expect(schema.EntityType?.map((type) => type._Name)).not.toContain('book_tag');
    });

    it('представление без первичного ключа не становится набором', () => {
      const schema = parseSchema(createMetadataDocument(dataSource));

      // `EntityType` обязан иметь `Key`; представление без ключа описать нечем.
      expect(schema.EntityType?.map((type) => type._Name)).not.toContain('BookSummary');
    });

    it('колонка внешнего ключа не дублирует связь', () => {
      const book = entityTypeNamed(parseSchema(createMetadataDocument(dataSource)), 'Book');

      // TypeORM держит `author_id` отдельной колонкой, но библиотека её не выбирает
      // (она виртуальная), а в модели OData за неё отвечает NavigationProperty.
      expect(book.Property?.map((property) => property._Name)).toEqual(['id', 'title', 'pages']);
    });
  });

  describe('ошибки', () => {
    it('неинициализированный DataSource отвергается', () => {
      const idle = new DataSource({ ...buildDataSourceOptions(), synchronize: false });

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
