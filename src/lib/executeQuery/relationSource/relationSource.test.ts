/**
 * @file Источник строк для подзапроса по связи: `FROM`, условие соединения и случаи отказа.
 *
 * Модуль обслуживает два внешних сценария — `searchFields: ['author/name']` и лямбды
 * `$filter=books/any(b: …)`, — но сам к базе не обращается: он переводит метаданные TypeORM
 * в текст SQL. Поэтому проверяется именно текст, а поведение на данных — матрицей.
 *
 * Метаданные берутся у настоящего `DataSource`, а не у мока: три ветки функции `step`
 * различают, где лежит внешний ключ, и ответ на этот вопрос даёт TypeORM, а не автор теста.
 * Мок проверял бы представление автора о TypeORM.
 *
 * Исключение — блок «неполные метаданные» в конце. Там связи собраны руками: каждая
 * ветка `step` начинается с проверки, что нужные колонки на месте, и получить настоящую
 * связь без них нельзя — TypeORM такую схему не соберёт. Проверки при этом не декоративные:
 * без них отсутствующая колонка молча дала бы `undefined` в тексте SQL.
 */
import type { EntityMetadata } from 'typeorm';

import { dataSource } from '../../../test/setup/dataSource';
import { buildRelationSource, createRelationResolver } from './relationSource';

/** Экранирование идентификатора по правилам текущего драйвера. */
const q = (name: string) => dataSource.driver.escape(name);

/** Ссылка на колонку: `"Author_books"."author_id"`. */
const ref = (alias: string, column: string) => `${q(alias)}.${q(column)}`;

/** Имя таблицы сущности так, как его видит текущий драйвер. */
const table = (entity: string) => dataSource.getMetadata(entity).tablePath;

/** Метаданные сущности по имени класса. */
const meta = (entity: string) => dataSource.getMetadata(entity);

describe('buildRelationSource', () => {
  describe('внешний ключ в родительской таблице', () => {
    it('«многие к одному» соединяется по ключу родителя', () => {
      const result = buildRelationSource(dataSource, meta('Book'), ['author'], 'Book', 'a');

      expect(result?.from).toBe(`${q(table('Author'))} ${q('a')}`);
      expect(result?.where).toBe(`${ref('a', 'id')} = ${ref('Book', 'author_id')}`);
      expect(result?.metadata.name).toBe('Author');
    });
  });

  describe('внешний ключ в дочерней таблице', () => {
    it('«один ко многим» соединяется по ключу ребёнка', () => {
      const result = buildRelationSource(dataSource, meta('Author'), ['books'], 'Author', 'b');

      expect(result?.from).toBe(`${q(table('Book'))} ${q('b')}`);
      expect(result?.where).toBe(`${ref('b', 'author_id')} = ${ref('Author', 'id')}`);
      expect(result?.metadata.name).toBe('Book');
    });

    it('обратная сторона «один к одному» соединяется так же', () => {
      // У `Book.details` нет `@JoinColumn` — ключ лежит в `book_details`, и ветка та же,
      // что у «один ко многим».
      const result = buildRelationSource(dataSource, meta('Book'), ['details'], 'Book', 'd');

      expect(result?.from).toBe(`${q(table('BookDetails'))} ${q('d')}`);
      expect(result?.where).toBe(`${ref('d', 'book_id')} = ${ref('Book', 'id')}`);
    });
  });

  describe('связь «многие ко многим»', () => {
    it('владеющая сторона добавляет таблицу связей в FROM', () => {
      const result = buildRelationSource(dataSource, meta('Book'), ['tags'], 'Book', 't');

      expect(result?.from).toBe(`${q('book_tag')} ${q('t__jt')}, ${q(table('Tag'))} ${q('t')}`);
      expect(result?.where).toBe(
        `${ref('t__jt', 'book_id')} = ${ref('Book', 'id')} AND ` +
          `${ref('t__jt', 'tag_id')} = ${ref('t', 'id')}`
      );
    });

    /**
     * Ради этого случая в `step` и живёт перестановка сторон. Колонки таблицы связей
     * описаны относительно владеющей стороны (`Book.tags`), а путь может начинаться
     * с обратной (`Tag.books`) — тогда `book_id` относится к ребёнку, а `tag_id`
     * к родителю, то есть наоборот. Перепутать их — получить связь тега с тегом.
     */
    it('обратная сторона меняет колонки таблицы связей местами', () => {
      const result = buildRelationSource(dataSource, meta('Tag'), ['books'], 'Tag', 'b');

      expect(result?.from).toBe(`${q('book_tag')} ${q('b__jt')}, ${q(table('Book'))} ${q('b')}`);
      expect(result?.where).toBe(
        `${ref('b__jt', 'tag_id')} = ${ref('Tag', 'id')} AND ` +
          `${ref('b__jt', 'book_id')} = ${ref('b', 'id')}`
      );
      expect(result?.metadata.name).toBe('Book');
    });
  });

  describe('путь из нескольких связей', () => {
    it('промежуточные звенья получают служебные алиасы', () => {
      const result = buildRelationSource(
        dataSource,
        meta('Author'),
        ['books', 'reviews'],
        'Author',
        'r'
      );

      // Последнее звено получает запрошенное имя, промежуточное — служебное.
      expect(result?.from).toBe(
        `${q(table('Book'))} ${q('r__n0')}, ${q(table('Review'))} ${q('r')}`
      );
      expect(result?.where).toBe(
        `${ref('r__n0', 'author_id')} = ${ref('Author', 'id')} AND ` +
          `${ref('r', 'book_id')} = ${ref('r__n0', 'id')}`
      );
      expect(result?.metadata.name).toBe('Review');
    });
  });

  describe('отказы', () => {
    it('пустой путь не даёт источника', () => {
      expect(buildRelationSource(dataSource, meta('Author'), [], 'Author', 'x')).toBeUndefined();
    });

    it('несуществующая связь не даёт источника', () => {
      expect(
        buildRelationSource(dataSource, meta('Author'), ['unknown'], 'Author', 'x')
      ).toBeUndefined();
    });

    it('несуществующее звено в середине пути не даёт источника', () => {
      expect(
        buildRelationSource(dataSource, meta('Author'), ['books', 'unknown'], 'Author', 'x')
      ).toBeUndefined();
    });
  });

  /**
   * Ниже связи собраны руками. Каждая ветка `step` начинается с проверки, что нужные
   * колонки на месте, и обойти её настоящей схемой нельзя: TypeORM либо соберёт связь
   * целиком, либо не соберёт вовсе. Проверки нужны потому, что отсутствующая колонка
   * не выбрасывает исключение — она даёт `undefined` в середине строки SQL, и запрос
   * уходит в базу с текстом `"b"."undefined" = …`.
   */
  describe('неполные метаданные', () => {
    /** Минимальная связь: `step` читает из неё только перечисленные здесь поля. */
    const relation = (fields: Record<string, unknown>) =>
      ({
        propertyPath: 'broken',
        joinColumns: [],
        inverseJoinColumns: [],
        isManyToMany: false,
        isOneToMany: false,
        isOneToOneNotOwner: false,
        isOwning: true,
        inverseEntityMetadata: { tablePath: 'child' },
        ...fields,
      }) as unknown as EntityMetadata['relations'][number];

    /** Сущность, у которой есть единственная связь `broken`. */
    const entity = (fields: Record<string, unknown>) =>
      ({ relations: [relation(fields)] }) as unknown as EntityMetadata;

    /** Колонка соединения с указанной целевой колонкой (или без неё). */
    const column = (databaseName: string, referenced?: string) => ({
      databaseName,
      referencedColumn: referenced ? { databaseName: referenced } : undefined,
    });

    const build = (source: EntityMetadata) =>
      buildRelationSource(dataSource, source, ['broken'], 'Parent', 'child');

    it.each([
      ['ключ родителя без целевой колонки', entity({ joinColumns: [column('child_id')] })],
      [
        '«один ко многим» без обратной связи',
        entity({ isOneToMany: true, inverseRelation: undefined }),
      ],
      [
        '«один ко многим» с пустой обратной связью',
        entity({ isOneToMany: true, inverseRelation: { joinColumns: [] } }),
      ],
      [
        '«один ко многим» без целевой колонки',
        entity({ isOneToMany: true, inverseRelation: { joinColumns: [column('parent_id')] } }),
      ],
      [
        '«многие ко многим» с обратной стороны без владеющей',
        entity({ isManyToMany: true, isOwning: false, inverseRelation: undefined }),
      ],
      [
        '«многие ко многим» без таблицы связей',
        entity({ isManyToMany: true, junctionEntityMetadata: undefined }),
      ],
      [
        '«многие ко многим» без колонок таблицы связей',
        entity({
          isManyToMany: true,
          junctionEntityMetadata: { tablePath: 'junction' },
          joinColumns: [],
          inverseJoinColumns: [],
        }),
      ],
      [
        '«многие ко многим» без целевой колонки',
        entity({
          isManyToMany: true,
          junctionEntityMetadata: { tablePath: 'junction' },
          joinColumns: [column('parent_id')],
          inverseJoinColumns: [column('child_id', 'id')],
        }),
      ],
      ['связь неизвестного вида', entity({})],
    ])('%s', (_name, source) => {
      expect(build(source)).toBeUndefined();
    });
  });
});

describe('createRelationResolver', () => {
  /** Резолвер от автора. Функция, а не константа: метаданные готовы только после `beforeAll`. */
  const resolver = () => createRelationResolver(dataSource, meta('Author'));

  it('отдаёт подзапрос вместе с резолвером от целевой сущности', () => {
    const source = resolver()(['books'], 'Author', 'b');

    expect(source?.from).toBe(`${q(table('Book'))} ${q('b')}`);
    // Вложенная лямбда считает связи от книги, а не от автора: без этого
    // `books/any(b: b/reviews/any(r: …))` искал бы `Author.reviews`.
    expect(source?.resolveRelation?.(['reviews'], 'b', 'r')?.from).toBe(
      `${q(table('Review'))} ${q('r')}`
    );
  });

  it('колонка целевой сущности получает её имя в базе', () => {
    const source = resolver()(['books'], 'Author', 'b');

    expect(source?.column('title')).toBe(ref('b', 'title'));
  });

  it('неизвестное имя уходит в запрос как есть', () => {
    // Про несуществующую колонку понятнее и точнее сообщит сама СУБД — так же ведут
    // себя и остальные пути библиотеки.
    const source = resolver()(['books'], 'Author', 'b');

    expect(source?.column('nonexistent')).toBe(ref('b', 'nonexistent'));
  });

  it('несуществующая связь не даёт подзапроса', () => {
    expect(resolver()(['unknown'], 'Author', 'x')).toBeUndefined();
  });
});
