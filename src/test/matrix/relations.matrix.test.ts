/**
 * @file Матрица: виды связей TypeORM.
 *
 * До появления общих фикстур в схеме были только «один ко многим» и «многие к одному»,
 * и три вида связей не проверялись вовсе: «многие ко многим» (через таблицу связи),
 * «один к одному» (даёт объект, а не массив) и ссылка сущности на саму себя (JOIN
 * таблицы с ней же, где алиасы обязаны различаться).
 *
 * Фикстуры (`src/test/fixtures/seed.sql`):
 *
 * | Книга | Автор | Издательство | Раздел | Метки | Выходные данные |
 * |---|---|---|---|---|---|
 * | 1 Analytical Engine | Ada | Clarendon (GB) | Computing | classic, reference | есть, ISBN есть |
 * | 2 Notes on Numbers | Ada | Clarendon (GB) | Mathematics | reference | есть, ISBN нет |
 * | 3 Compiler Theory | Grace | MIT (US) | Computing | classic, history | есть, ISBN есть |
 * | 4 Enigma Machines | Alan | MIT (US) | Computing | history | нет |
 * | 5 Orphan Book | — | Manning (US) | — | — | нет |
 *
 * Разделы: Science(1) → Mathematics(2), Computing(3); Fiction(4) — корень без детей.
 */
import { Book, Category } from '../fixtures';
import { dataSource } from '../setup/dataSource';
import { bookIds, categoryIds, rows, runMatrix } from './helpers';

describe('«многие ко многим»: фильтр по метке', () => {
  runMatrix(bookIds, [
    { name: 'tags/label eq classic', query: { $filter: "tags/label eq 'classic'" }, expected: [1, 3] },
    { name: 'tags/label eq history', query: { $filter: "tags/label eq 'history'" }, expected: [3, 4] },
    {
      name: 'метка, которой ни у кого нет',
      query: { $filter: "tags/label eq 'unread'" },
      expected: [],
    },
    {
      name: 'contains по метке',
      query: { $filter: "contains(tags/label,'refer')" },
      expected: [1, 2],
    },
  ]);

  it('книга с двумя метками не задваивается в выдаче', async () => {
    // LEFT JOIN к таблице связи размножает корневые строки; TypeORM склеивает их обратно
    // по идентификатору. Без этого книга 1 (две метки) вернулась бы дважды.
    expect(await bookIds({ $expand: 'tags' })).toEqual([1, 2, 3, 4, 5]);
  });

  it('$expand=tags отдаёт массив меток', async () => {
    const result = await rows(
      dataSource.getRepository(Book),
      { $expand: 'tags', $filter: 'id eq 1' },
      'Book'
    );

    expect(result[0]?.tags.map((tag) => tag.label).sort()).toEqual(['classic', 'reference']);
  });

  it('книга без меток даёт пустой массив, а не отсутствие поля', async () => {
    const result = await rows(
      dataSource.getRepository(Book),
      { $expand: 'tags', $filter: 'id eq 5' },
      'Book'
    );

    expect(result[0]?.tags).toEqual([]);
  });

  it('вложенный $select внутри $expand=tags отдаёт ровно запрошенное', async () => {
    const result = await rows(
      dataSource.getRepository(Book),
      { $expand: 'tags($select=label)', $filter: 'id eq 2' },
      'Book'
    );

    // Здесь `id` не возвращается, а для связи «один ко многим» — возвращается
    // (см. `$expand=books($select=title)` в queryOptions.matrix). Разница не в библиотеке:
    // при связи «один ко многим» строки склеиваются с родителем по ключу, и TypeORM
    // добавляет его в выборку сам. Метки же приезжают через таблицу связи, где ключ
    // уже есть, и ничего дописывать не требуется.
    //
    // Спецификации OData ближе как раз это поведение: `$select=label` просил одно поле.
    expect(Object.keys(result[0]!.tags[0]!)).toEqual(['label']);
  });
});

describe('«один к одному»: выходные данные книги', () => {
  runMatrix(bookIds, [
    {
      name: 'details/isbn ne null',
      query: { $filter: 'details/isbn ne null' },
      expected: [1, 3],
    },
    {
      name: 'details/isbn eq null — сюда попадают и книги без выходных данных',
      query: { $filter: 'details/isbn eq null' },
      expected: [2, 4, 5],
    },
    {
      name: 'фильтр по времени из связи',
      query: { $filter: "details/releaseTime eq '09:00:00'" },
      expected: [1],
    },
  ]);

  it('$expand=details отдаёт объект, а не массив', async () => {
    const result = await rows(
      dataSource.getRepository(Book),
      { $expand: 'details', $filter: 'id eq 1' },
      'Book'
    );

    expect(Array.isArray(result[0]?.details)).toBe(false);
    expect(result[0]?.details?.isbn).toBe('9780000000001');
  });

  it('книга без выходных данных даёт null', async () => {
    const result = await rows(
      dataSource.getRepository(Book),
      { $expand: 'details', $filter: 'id eq 4' },
      'Book'
    );

    expect(result[0]?.details).toBeNull();
  });
});

describe('ссылка на саму себя: разделы каталога', () => {
  runMatrix(categoryIds, [
    {
      name: 'дети раздела Science',
      query: { $filter: "parent/name eq 'Science'" },
      expected: [2, 3],
    },
    { name: 'корневые разделы', query: { $filter: 'parent eq null' }, expected: [1, 4] },
    {
      name: 'сортировка по имени родителя',
      query: { $filter: 'parent ne null', $orderby: 'name desc' },
      expected: [2, 3],
      sorted: true,
    },
  ]);

  it('$expand=children даёт вложенные разделы', async () => {
    const result = await rows(
      dataSource.getRepository(Category),
      { $expand: 'children', $filter: 'id eq 1' },
      'Category'
    );

    expect(result[0]?.children.map((child) => child.name).sort()).toEqual([
      'Computing',
      'Mathematics',
    ]);
  });

  it('$expand=parent на корневом разделе даёт null', async () => {
    const result = await rows(
      dataSource.getRepository(Category),
      { $expand: 'parent', $filter: 'id eq 4' },
      'Category'
    );

    expect(result[0]?.parent).toBeNull();
  });
});

describe('путь через две связи', () => {
  runMatrix(bookIds, [
    {
      name: 'category/parent/name — два перехода подряд',
      query: { $filter: "category/parent/name eq 'Science'" },
      expected: [1, 2, 3, 4],
    },
    {
      name: 'publisher/country — обязательная связь',
      query: { $filter: "publisher/country eq 'US'" },
      expected: [3, 4, 5],
    },
    {
      name: 'фильтры по двум разным связям сразу',
      query: { $filter: "publisher/country eq 'GB' and category/name eq 'Computing'" },
      expected: [1],
    },
  ]);

  it('сортировка по полю связи', async () => {
    expect(
      await bookIds({ $orderby: 'publisher/name asc,id asc', $filter: 'id ne 5' })
    ).toEqual([1, 2, 3, 4]);
  });

  it('$expand по цепочке связей', async () => {
    const result = await rows(
      dataSource.getRepository(Book),
      { $expand: 'publisher,category($expand=parent)', $filter: 'id eq 1' },
      'Book'
    );

    expect(result[0]?.publisher.name).toBe('Clarendon Press');
    expect(result[0]?.category?.parent?.name).toBe('Science');
  });
});
