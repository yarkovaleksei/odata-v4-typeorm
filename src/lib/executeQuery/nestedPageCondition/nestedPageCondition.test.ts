/**
 * @file Условие вложенной пагинации: форма генерируемого SQL и случаи отказа.
 *
 * Метаданные берутся у настоящего `DataSource` тестов, а не у мока: условие целиком строится
 * из них — имена таблиц, колонки соединения, первичные ключи, — и мок проверял бы
 * представление автора о TypeORM, а не поведение TypeORM. Поведение же на реальных данных
 * проверяет матрица (`queryOptions.matrix`).
 */
import { normalizeDialect, supportsNestedPagePushdown } from '../../dialect';
import { dataSource } from '../../../test/setup/dataSource';
import { buildNestedPageCondition } from './nestedPageCondition';

/**
 * Экранирование идентификатора по правилам текущего драйвера: PostgreSQL и SQLite берут
 * имя в двойные кавычки, MySQL — в обратные. Ожидания записываются через эту функцию,
 * иначе матрица на MySQL падала бы на кавычках, а не на поведении.
 */
const q = (name: string) => dataSource.driver.escape(name);

/** Ссылка на колонку: `"Author_books"."author_id"`. */
const ref = (alias: string, column: string) => `${q(alias)}.${q(column)}`;

/**
 * Переносится ли вложенная пагинация в SQL на текущей СУБД. На MySQL — нет: он считает
 * окно после наложения внешнего условия и вернул бы неверную страницу.
 */
const pushdown = supportsNestedPagePushdown(normalizeDialect(dataSource.options.type));

/**
 * Форма SQL проверяется только там, где перенос вообще разрешён. На остальных СУБД
 * условие не строится, и это проверяется отдельным блоком в конце файла.
 */
const describeWherePushdown = pushdown ? describe : describe.skip;

/** Метаданные связи по имени сущности и пути свойства. */
function relationOf(entity: string, propertyPath: string) {
  const relation = dataSource
    .getMetadata(entity)
    .relations.find((candidate) => candidate.propertyPath === propertyPath);

  if (!relation) {
    throw new Error(`в фикстурах нет связи ${entity}.${propertyPath}`);
  }

  return relation;
}

/** Границы страницы в том виде, в каком их оставляет посетитель. */
function page(alias: string, limit?: number, skip?: number) {
  return { alias, limit, skip } as { alias: string; limit: number; skip: number };
}

/** Фрагменты вложенных `$filter` и `$orderby` со значениями по умолчанию. */
const noFragments = { where: '1 = 1', orderby: '1' };

describe('buildNestedPageCondition', () => {
  describeWherePushdown('связь «один ко многим»', () => {
    it('нумерует строки по внешнему ключу и отбирает страницу через IN', () => {
      const result = buildNestedPageCondition(
        dataSource,
        relationOf('Author', 'books'),
        'Author',
        page('Author_books', 2, 1),
        noFragments
      );

      expect(result).toBeDefined();
      expect(result?.condition).toContain('ROW_NUMBER() OVER (PARTITION BY');
      // Нумерация — по колонке внешнего ключа связанной таблицы.
      expect(result?.condition).toContain(ref('Author_books', 'author_id'));
      // Форма IN, а не EXISTS: подзапрос не коррелирован и вычисляется один раз.
      expect(result?.condition.startsWith(`${ref('Author_books', 'id')} IN (SELECT`)).toBe(true);
      expect(result?.condition).not.toContain('EXISTS');
      // Верхняя граница — абсолютный номер строки: смещение плюс размер страницы.
      expect(result?.parameters).toEqual({ Author_books__skip: 1, Author_books__end: 3 });
    });

    it('без $skip нижней границы нет', () => {
      const result = buildNestedPageCondition(
        dataSource,
        relationOf('Author', 'books'),
        'Author',
        page('Author_books', 1),
        noFragments
      );

      expect(result?.parameters).toEqual({ Author_books__end: 1 });
      expect(result?.condition).not.toContain('__skip');
    });

    it('$top=0 даёт границы, не пропускающие ни одной строки', () => {
      const result = buildNestedPageCondition(
        dataSource,
        relationOf('Author', 'books'),
        'Author',
        page('Author_books', 0, 2),
        noFragments
      );

      // rn > 2 и rn <= 2 одновременно не выполняются — пустая страница, как требует
      // OData v4 (раздел 11.2.6.4).
      expect(result?.parameters).toEqual({ Author_books__skip: 2, Author_books__end: 2 });
    });

    it('первичный ключ дописывается в сортировку окна', () => {
      const result = buildNestedPageCondition(
        dataSource,
        relationOf('Author', 'books'),
        'Author',
        page('Author_books', 1),
        { where: '1 = 1', orderby: 'Author_books.pages DESC' }
      );

      // Фрагмент вставляется как есть: имя свойства в имя колонки превратит сам TypeORM.
      expect(result?.condition).toContain(
        `ORDER BY Author_books.pages DESC, ${ref('Author_books', 'id')} ASC`
      );
    });

    it('колонка, уже упомянутая в сортировке, второй раз не добавляется', () => {
      const result = buildNestedPageCondition(
        dataSource,
        relationOf('Author', 'books'),
        'Author',
        page('Author_books', 1),
        { where: '1 = 1', orderby: 'Author_books.id DESC' }
      );

      expect(result?.condition).toContain('ORDER BY Author_books.id DESC)');
    });

    it('вложенный $filter уходит внутрь подзапроса — страница считается после отбора', () => {
      const result = buildNestedPageCondition(
        dataSource,
        relationOf('Author', 'books'),
        'Author',
        page('Author_books', 1),
        { where: 'Author_books.pages > :p0', orderby: '1' }
      );

      expect(result?.condition).toContain('WHERE Author_books.pages > :p0)');
    });
  });

  describeWherePushdown('связь «многие ко многим»', () => {
    it('нумерует строки таблицы связей и коррелирует по обоим ключам', () => {
      const result = buildNestedPageCondition(
        dataSource,
        relationOf('Book', 'tags'),
        'Book',
        page('Book_tags', 1),
        noFragments
      );

      expect(result?.condition.startsWith('EXISTS (SELECT 1 FROM (SELECT')).toBe(true);
      // Нумерация идёт по колонке владельца в таблице связей.
      expect(result?.condition).toContain(`PARTITION BY ${ref('Book_tags__jt', 'book_id')}`);
      expect(result?.condition).toContain(`${q('book_tag')} ${q('Book_tags__jt')}`);
      // Корреляция — и по родителю, и по самой связанной строке: одна и та же метка
      // попадает в разные страницы у разных книг.
      expect(result?.condition).toContain(
        `${ref('Book_tags__page', '__p0')} = ${ref('Book', 'id')}`
      );
      expect(result?.condition).toContain(
        `${ref('Book_tags__page', '__k0')} = ${ref('Book_tags', 'id')}`
      );
    });

    it('с обратной стороны связи колонки таблицы связей меняются ролями', () => {
      const result = buildNestedPageCondition(
        dataSource,
        relationOf('Tag', 'books'),
        'Tag',
        page('Tag_books', 1),
        noFragments
      );

      // Владелец связи — Book, но родителем здесь выступает Tag.
      expect(result?.condition).toContain(`PARTITION BY ${ref('Tag_books__jt', 'tag_id')}`);
      expect(result?.condition).toContain(
        `${ref('Tag_books__page', '__p0')} = ${ref('Tag', 'id')}`
      );
      expect(result?.condition).toContain(
        `${ref('Tag_books__page', '__k0')} = ${ref('Tag_books', 'id')}`
      );
    });
  });

  describe('когда перенос в SQL невозможен', () => {
    it('без $top и $skip условие не нужно', () => {
      expect(
        buildNestedPageCondition(
          dataSource,
          relationOf('Author', 'books'),
          'Author',
          page('Author_books'),
          noFragments
        )
      ).toBeUndefined();
    });

    it('нулевой $skip без $top ничего не ограничивает', () => {
      expect(
        buildNestedPageCondition(
          dataSource,
          relationOf('Author', 'books'),
          'Author',
          page('Author_books', undefined, 0),
          noFragments
        )
      ).toBeUndefined();
    });

    it('одиночная связь страницы не имеет', () => {
      // ManyToOne: у книги ровно один автор, ограничивать нечего.
      expect(
        buildNestedPageCondition(
          dataSource,
          relationOf('Book', 'author'),
          'Book',
          page('Book_author', 1),
          noFragments
        )
      ).toBeUndefined();

      // OneToOne — тот же случай.
      expect(
        buildNestedPageCondition(
          dataSource,
          relationOf('Book', 'details'),
          'Book',
          page('Book_details', 1),
          noFragments
        )
      ).toBeUndefined();
    });

    it('сортировка по соседней связи не переносится: её алиаса в подзапросе нет', () => {
      expect(
        buildNestedPageCondition(
          dataSource,
          relationOf('Author', 'books'),
          'Author',
          page('Author_books', 1),
          { where: '1 = 1', orderby: 'Author_books_category.name ASC' }
        )
      ).toBeUndefined();
    });

    it('фильтр по соседней связи не переносится по той же причине', () => {
      expect(
        buildNestedPageCondition(
          dataSource,
          relationOf('Author', 'books'),
          'Author',
          page('Author_books', 1),
          { where: 'Author_books_reviews.score > :p0', orderby: '1' }
        )
      ).toBeUndefined();
    });

    it('без алиаса родителя не на что сослаться', () => {
      expect(
        buildNestedPageCondition(
          dataSource,
          relationOf('Author', 'books'),
          '',
          page('Author_books', 1),
          noFragments
        )
      ).toBeUndefined();
    });
  });

  describeWherePushdown('экранированные алиасы во вложенных фрагментах', () => {
    /**
     * Вложенные `$filter` и `$orderby` попадают внутрь подзапроса как есть, поэтому обязаны
     * ссылаться только на саму связь. Посетитель пишет алиас без кавычек, но фрагмент мог
     * прийти и от вызывающего кода — тогда он записан по правилам своего диалекта.
     * Не узнать в `"Author_books"` тот же алиас значило бы отказаться от переноса там,
     * где он полностью корректен.
     */
    it.each([
      ['двойные кавычки', '"Author_books"."pages" > :p0'],
      ['обратные кавычки', '`Author_books`.`pages` > :p0'],
      ['квадратные скобки', '[Author_books].[pages] > :p0'],
    ])('%s распознаются как тот же алиас', (_name, where) => {
      const result = buildNestedPageCondition(
        dataSource,
        relationOf('Author', 'books'),
        'Author',
        page('Author_books', 2),
        { where, orderby: '1' }
      );

      expect(result).toBeDefined();
      expect(result?.condition).toContain(where);
    });

    it('чужой алиас во фрагменте запрещает перенос', () => {
      // Алиаса соседнего JOIN внутри подзапроса не существует — перенос дал бы битый SQL.
      const result = buildNestedPageCondition(
        dataSource,
        relationOf('Author', 'books'),
        'Author',
        page('Author_books', 2),
        { where: '"Author_books_reviews"."score" > :p0', orderby: '1' }
      );

      expect(result).toBeUndefined();
    });
  });

  /**
   * Ниже связи собраны руками. Каждая ветка сборки источника начинается с проверки, что
   * нужные колонки на месте, и обойти её настоящей схемой нельзя: TypeORM либо соберёт
   * связь целиком, либо не соберёт вовсе. Отказ здесь безопасен — страницу вырежет
   * `applyNestedPagination` в памяти; опасно было бы построить условие по половине
   * метаданных и молча вернуть не ту страницу.
   */
  describeWherePushdown('неполные метаданные', () => {
    /** Колонка соединения с указанной целевой колонкой (или без неё). */
    const column = (databaseName: string, referenced?: string) => ({
      databaseName,
      referencedColumn: referenced ? { databaseName: referenced } : undefined,
    });

    /** Минимальная связь-коллекция: читаются только перечисленные здесь поля. */
    const relation = (fields: Record<string, unknown>) =>
      ({
        isOneToMany: false,
        isManyToMany: false,
        isOwning: true,
        joinColumns: [],
        inverseJoinColumns: [],
        inverseEntityMetadata: { tablePath: 'child' },
        ...fields,
      }) as unknown as ReturnType<typeof relationOf>;

    it.each([
      ['«один ко многим» без обратной связи', relation({ isOneToMany: true })],
      [
        '«один ко многим» с пустой обратной связью',
        relation({ isOneToMany: true, inverseRelation: { joinColumns: [] } }),
      ],
      [
        '«один ко многим» без целевой колонки родителя',
        relation({ isOneToMany: true, inverseRelation: { joinColumns: [column('parent_id')] } }),
      ],
      [
        '«многие ко многим» с обратной стороны без владеющей',
        relation({ isManyToMany: true, isOwning: false }),
      ],
      [
        '«многие ко многим» без таблицы связей',
        relation({ isManyToMany: true, junctionEntityMetadata: undefined }),
      ],
      [
        '«многие ко многим» без колонок таблицы связей',
        relation({ isManyToMany: true, junctionEntityMetadata: { tablePath: 'junction' } }),
      ],
      [
        '«многие ко многим» без целевой колонки родителя',
        relation({
          isManyToMany: true,
          junctionEntityMetadata: { tablePath: 'junction' },
          joinColumns: [column('parent_id')],
          inverseJoinColumns: [column('child_id', 'id')],
        }),
      ],
      [
        '«многие ко многим» без целевой колонки ребёнка',
        relation({
          isManyToMany: true,
          junctionEntityMetadata: { tablePath: 'junction' },
          joinColumns: [column('parent_id', 'id')],
          inverseJoinColumns: [column('child_id')],
        }),
      ],
    ])('%s не даёт условия', (_name, broken) => {
      expect(
        buildNestedPageCondition(dataSource, broken, 'Parent', page('child', 2), noFragments)
      ).toBeUndefined();
    });
  });

  /**
   * MySQL считает окно после того, как протолкнёт внешнее условие внутрь подзапроса,
   * поэтому страница получилась бы неверной молча. Условие там не строится вовсе —
   * срез делает `applyNestedPagination`. Подробности — в `supportsNestedPagePushdown`.
   */
  (pushdown ? describe.skip : describe)('на СУБД, где перенос запрещён', () => {
    it('условие не строится ни для одной связи', () => {
      const oneToMany = buildNestedPageCondition(
        dataSource,
        relationOf('Author', 'books'),
        'Author',
        page('Author_books', 1),
        noFragments
      );

      const manyToMany = buildNestedPageCondition(
        dataSource,
        relationOf('Book', 'tags'),
        'Book',
        page('Book_tags', 1),
        noFragments
      );

      expect(oneToMany).toBeUndefined();
      expect(manyToMany).toBeUndefined();
    });
  });
});
