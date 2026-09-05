/**
 * @file Матрица совместимости: `$select`, `$orderby`, `$top`, `$skip`, `$count`, `$expand`, `$search`.
 *
 * Ожидания записаны по спецификации OData v4. Отступления, принятые в этой библиотеке
 * осознанно (например форма ответа при `$count`), помечены комментарием со ссылкой на документ,
 * где отступление зафиксировано.
 */
import { executeQuery } from '../../lib/executeQuery';
import { Author, Book } from '../entity';
import { dataSource } from '../setup/dataSource';
import { authorIds, bookIds, rows, runMatrix, type MatrixCase } from './helpers';

describe('$orderby', () => {
  const cases: readonly MatrixCase[] = [
    {
      name: 'по возрастанию явно',
      query: { $orderby: 'age asc' },
      expected: [4, 1, 3, 2],
      sorted: true,
    },
    {
      name: 'по убыванию',
      query: { $orderby: 'age desc' },
      expected: [2, 3, 1, 4],
      sorted: true,
    },
    {
      name: 'направление по умолчанию — asc',
      query: { $orderby: 'age' },
      expected: [4, 1, 3, 2],
      sorted: true,
    },
    {
      name: 'по строке',
      query: { $orderby: 'name asc' },
      expected: [1, 3, 4, 2],
      sorted: true,
    },
    {
      name: 'по двум полям',
      query: { $orderby: 'rating desc,name asc' },
      expected: [2, 1, 4, 3],
      sorted: true,
    },
  ];

  runMatrix(authorIds, cases);
});

describe('$top и $skip', () => {
  const cases: readonly MatrixCase[] = [
    { name: '$top ограничивает выдачу', query: { $orderby: 'id asc', $top: '2' }, expected: [1, 2], sorted: true },
    { name: '$skip пропускает начало', query: { $orderby: 'id asc', $skip: '2' }, expected: [3, 4], sorted: true },
    {
      name: '$top и $skip вместе',
      query: { $orderby: 'id asc', $top: '2', $skip: '1' },
      expected: [2, 3],
      sorted: true,
    },
    {
      name: '$skip больше размера выборки',
      query: { $orderby: 'id asc', $skip: '10' },
      expected: [],
      sorted: true,
    },
    // OData v4, раздел 5.1.5: $top=0 обязан вернуть пустую страницу, а не «лимита нет».
    { name: '$top=0 возвращает пустую страницу', query: { $top: '0' }, expected: [], sorted: true },
  ];

  runMatrix(authorIds, cases);
});

describe('$select', () => {
  it('возвращает только указанные поля', async () => {
    const result = await rows(dataSource.getRepository(Author), { $select: 'id,name' }, 'Author');

    expect(result).toHaveLength(4);
    expect(Object.keys(result[0]).sort()).toEqual(['id', 'name']);
  });

  it('одно поле', async () => {
    const result = await rows(dataSource.getRepository(Author), { $select: 'name' }, 'Author');

    expect(Object.keys(result[0])).toEqual(['name']);
  });

  it('сочетается с $filter', async () => {
    const result = await rows(
      dataSource.getRepository(Author),
      { $select: 'id,age', $filter: 'age gt 40' },
      'Author'
    );

    expect(result.map((r) => r.id).sort()).toEqual([2, 3]);
    expect(Object.keys(result[0]).sort()).toEqual(['age', 'id']);
  });
});

describe('$count', () => {
  it('$count=true возвращает страницу и общее число строк', async () => {
    const result = await executeQuery(
      dataSource.getRepository(Author),
      { $count: 'true', $top: '2', $orderby: 'id asc' },
      { alias: 'Author' }
    );

    expect(result).toEqual({
      items: expect.any(Array),
      count: 4,
    });
    // count игнорирует $top: это общее число строк по фильтрам
    expect((result as { items: Author[] }).items).toHaveLength(2);
  });

  it('$count учитывает $filter', async () => {
    const result = await executeQuery(
      dataSource.getRepository(Author),
      { $count: 'true', $filter: 'age gt 40' },
      { alias: 'Author' }
    );

    expect((result as { count: number }).count).toBe(2);
  });

  it('$count=false возвращает массив', async () => {
    const result = await executeQuery(
      dataSource.getRepository(Author),
      { $count: 'false' },
      { alias: 'Author' }
    );

    expect(Array.isArray(result)).toBe(true);
  });

  /**
   * ОТСТУПЛЕНИЕ ОТ СПЕЦИФИКАЦИИ. По OData v4 отсутствующий `$count` эквивалентен `false`,
   * то есть ответом должен быть массив. Здесь по умолчанию возвращается `{ items, count }`.
   * Отступление зафиксировано в `docs/audit.md` (Н-01) и `docs/odata-support.md`.
   * Тест закрепляет текущее поведение, чтобы его нельзя было изменить незаметно.
   */
  it('без $count возвращает объект (отступление от спецификации)', async () => {
    const result = await executeQuery(dataSource.getRepository(Author), {}, { alias: 'Author' });

    expect(Array.isArray(result)).toBe(false);
    expect(result).toHaveProperty('items');
    expect(result).toHaveProperty('count', 4);
  });
});

describe('$expand', () => {
  it('загружает связь one-to-many', async () => {
    const result = await rows(
      dataSource.getRepository(Author),
      { $expand: 'books', $filter: "name eq 'Ada'" },
      'Author'
    );

    expect(result).toHaveLength(1);
    expect(result[0].books.map((b) => b.id).sort()).toEqual([1, 2]);
  });

  it('загружает связь many-to-one', async () => {
    const result = await rows(
      dataSource.getRepository(Book),
      { $expand: 'author', $filter: 'id eq 1' },
      'Book'
    );

    expect(result[0].author?.name).toBe('Ada');
  });

  it('делает LEFT JOIN: сущность без связанной записи остаётся в выдаче', async () => {
    const result = await rows(dataSource.getRepository(Book), { $expand: 'author' }, 'Book');

    const orphan = result.find((b) => b.id === 5);

    expect(orphan).toBeDefined();
    expect(orphan?.author).toBeNull();
  });

  it('вложенный $select ограничивает поля связи', async () => {
    const result = await rows(
      dataSource.getRepository(Author),
      { $expand: 'books($select=id,title)', $filter: "name eq 'Ada'" },
      'Author'
    );

    expect(Object.keys(result[0].books[0]).sort()).toEqual(['id', 'title']);
  });

  it('вложенный $orderby сортирует связанные записи', async () => {
    const result = await rows(
      dataSource.getRepository(Author),
      { $expand: 'books($orderby=id desc)', $filter: "name eq 'Ada'" },
      'Author'
    );

    expect(result[0].books.map((b) => b.id)).toEqual([2, 1]);
  });

  it('вложенный $expand второго уровня', async () => {
    const result = await rows(
      dataSource.getRepository(Author),
      { $expand: 'books($expand=reviews)', $filter: "name eq 'Ada'" },
      'Author'
    );

    const firstBook = result[0].books.find((b) => b.id === 1);

    expect(firstBook?.reviews.map((r) => r.id).sort()).toEqual([1, 2]);
  });

  it('несколько связей одновременно', async () => {
    const result = await rows(
      dataSource.getRepository(Book),
      { $expand: 'author,reviews', $filter: 'id eq 1' },
      'Book'
    );

    expect(result[0].author?.name).toBe('Ada');
    expect(result[0].reviews).toHaveLength(2);
  });

  // Дефект A-02: алиас JOIN и алиас в WHERE должны совпадать.
  it('сочетается с $filter по той же связи', async () => {
    const result = await bookIds({ $expand: 'author', $filter: "author/name eq 'Ada'" });

    expect(result.sort()).toEqual([1, 2]);
  });

  // Дефект A-02, вторая половина: то же для сортировки.
  it('сочетается с $orderby по той же связи', async () => {
    const result = await rows(
      dataSource.getRepository(Book),
      { $expand: 'author', $filter: 'author/id ne null', $orderby: 'author/name asc,id asc' },
      'Book'
    );

    expect(result.map((b) => b.author?.name)).toEqual(['Ada', 'Ada', 'Alan', 'Grace']);
  });

  // Дефект A-04: повторный $expand одной связи не должен множить JOIN.
  it('повторный $expand одной связи объединяется', async () => {
    const result = await rows(
      dataSource.getRepository(Author),
      { $expand: 'books($select=id),books($select=title)', $filter: "name eq 'Ada'" },
      'Author'
    );

    expect(result).toHaveLength(1);
    expect(Object.keys(result[0].books[0]).sort()).toEqual(['id', 'title']);
  });
});

describe('$search', () => {
  const cases: readonly MatrixCase[] = [
    { name: 'по подстроке в тексте', query: { $search: 'ada' }, expected: [1] },
    { name: 'регистронезависимость', query: { $search: 'ADA' }, expected: [1] },
    { name: 'по подстроке в nullable-колонке', query: { $search: 'Codebreaker' }, expected: [3] },
    { name: 'по числовой колонке', query: { $search: '41' }, expected: [3] },
    { name: 'ничего не найдено', query: { $search: 'нет-такого' }, expected: [] },
    {
      name: 'сочетается с $filter через AND',
      query: { $search: 'a', $filter: 'age gt 40' },
      expected: [2, 3],
    },
  ];

  runMatrix(authorIds, cases);

  it('не подвержен инъекции', async () => {
    const result = await authorIds({ $search: "'; DROP TABLE author; --" });

    expect(result).toEqual([]);

    // Таблица на месте — значит инъекция не сработала
    expect(await authorIds({})).toHaveLength(4);
  });
});

describe('комбинации опций', () => {
  it('$filter + $select + $orderby + $top', async () => {
    const result = await rows(
      dataSource.getRepository(Author),
      { $filter: 'age gt 30', $select: 'id,name', $orderby: 'name asc', $top: '2' },
      'Author'
    );

    expect(result.map((r) => r.name)).toEqual(['Ada', 'Alan']);
    expect(Object.keys(result[0]).sort()).toEqual(['id', 'name']);
  });

  it('$expand + $filter по корню + пагинация', async () => {
    const result = await rows(
      dataSource.getRepository(Author),
      { $expand: 'books', $filter: 'isActive eq true', $orderby: 'id asc', $top: '2' },
      'Author'
    );

    expect(result.map((r) => r.id)).toEqual([1, 2]);
    expect(result[0].books).toHaveLength(2);
  });
});
