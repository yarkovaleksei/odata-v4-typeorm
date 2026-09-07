/**
 * @file Матрица совместимости: `$select`, `$orderby`, `$top`, `$skip`, `$count`, `$expand`, `$search`.
 *
 * Ожидания записаны по спецификации OData v4. Отступления, принятые в этой библиотеке
 * осознанно (например форма ответа при `$count`), помечены комментарием со ссылкой на документ,
 * где отступление зафиксировано.
 */
import { normalizeDialect, supportsNestedPagePushdown } from '../../lib/dialect';
import { ODataInvalidQueryError } from '../../lib/errors';
import { executeQuery } from '../../lib/executeQuery';
import type { QueryParams } from '../../lib/types';
import { Author, Book, Publisher, Tag } from '../fixtures';
import { dataSource, testDatabase } from '../setup/dataSource';
import {
  authorIds,
  bookIds,
  captureSql,
  expectRejected,
  rows,
  runMatrix,
  type MatrixCase,
} from './helpers';

/** Переносится ли вложенная пагинация в SQL на текущей СУБД (на MySQL — нет). */
const pushdown = supportsNestedPagePushdown(normalizeDialect(dataSource.options.type));

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
    {
      name: '$top ограничивает выдачу',
      query: { $orderby: 'id asc', $top: '2' },
      expected: [1, 2],
      sorted: true,
    },
    {
      name: '$skip пропускает начало',
      query: { $orderby: 'id asc', $skip: '2' },
      expected: [3, 4],
      sorted: true,
    },
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
    expect(Object.keys(result[0]!).sort()).toEqual(['id', 'name']);
  });

  it('одно поле', async () => {
    const result = await rows(dataSource.getRepository(Author), { $select: 'name' }, 'Author');

    expect(Object.keys(result[0]!)).toEqual(['name']);
  });

  it('сочетается с $filter', async () => {
    const result = await rows(
      dataSource.getRepository(Author),
      { $select: 'id,age', $filter: 'age gt 40' },
      'Author'
    );

    expect(result.map((r) => r.id).sort()).toEqual([2, 3]);
    expect(Object.keys(result[0]!).sort()).toEqual(['age', 'id']);
  });

  /**
   * Дефект A-17: `$select` без первичного ключа вместе с соединением и пагинацией
   * не выполнялся вовсе.
   *
   * При `take` либо `skip` и хотя бы одном `JOIN` TypeORM идёт в два приёма и выбирает ключи
   * страницы подзапросом `SELECT DISTINCT "distinctAlias"."Author_id" FROM (<исходный запрос>)`.
   * Ключа не было во внутреннем запросе — не было и колонки, на которую ссылается внешний:
   * запрос падал ошибкой уровня СУБД. Теперь ключ дописывается в выборку и убирается
   * из ответа, поэтому форма ответа от `$top` не зависит.
   */
  describe('без первичного ключа вместе с соединением и пагинацией (A-17)', () => {
    const withoutKey = { $select: 'name', $orderby: 'id asc' } as const;

    it('$expand и $top', async () => {
      const result = await rows(
        dataSource.getRepository(Author),
        { ...withoutKey, $expand: 'books', $top: '2' },
        'Author'
      );

      expect(result.map((r) => r.name)).toEqual(['Ada', 'Grace']);
      // Ключ добавлялся ради SQL и в ответ попасть не должен; связь при этом на месте.
      expect(Object.keys(result[0]!).sort()).toEqual(['books', 'name']);
    });

    it('$expand и $skip', async () => {
      const result = await rows(
        dataSource.getRepository(Author),
        { ...withoutKey, $expand: 'books', $skip: '2' },
        'Author'
      );

      expect(result.map((r) => r.name)).toEqual(['Alan', 'Barbara']);
    });

    it('соединение из пути в $filter, без $expand', async () => {
      // Путь `связь/поле` создаёт «виртуальный» include — соединение есть, хотя $expand нет.
      const result = await rows(
        dataSource.getRepository(Author),
        { ...withoutKey, $filter: 'books/pages gt 100', $top: '2' },
        'Author'
      );

      expect(result.map((r) => r.name)).toEqual(['Ada', 'Grace']);
      expect(Object.keys(result[0]!)).toEqual(['name']);
    });

    it('форма ответа не зависит от того, добавлен ли $top', async () => {
      const repository = dataSource.getRepository(Author);
      const query = { ...withoutKey, $expand: 'books' };

      const withoutTop = await rows(repository, query, 'Author');
      const withTop = await rows(repository, { ...query, $top: '4' }, 'Author');

      expect(Object.keys(withTop[0]!).sort()).toEqual(Object.keys(withoutTop[0]!).sort());
    });

    it('$count вместе с пагинацией и соединением', async () => {
      const result = await executeQuery(
        dataSource.getRepository(Author),
        { ...withoutKey, $expand: 'books', $top: '2', $count: 'true' },
        { alias: 'Author' }
      );

      const page = result as { items: Array<{ name: string }>; count: number };

      expect(page.count).toBe(4);
      expect(page.items.map((item) => item.name)).toEqual(['Ada', 'Grace']);
      expect(Object.keys(page.items[0]!).sort()).toEqual(['books', 'name']);
    });

    it('сущность с ключом UUID', async () => {
      // Ключ берётся из метаданных, а не по имени `id`, поэтому его тип роли не играет.
      const result = await rows(
        dataSource.getRepository(Publisher),
        { $select: 'name', $expand: 'books', $orderby: 'name asc', $top: '2' },
        'Publisher'
      );

      expect(result).toHaveLength(2);
      expect(Object.keys(result[0]!).sort()).toEqual(['books', 'name']);
    });
  });
});

/**
 * Дефект A-18, родственный A-17 и найденный тем же прогоном.
 *
 * Двухшаговая пагинация ссылается не только на первичный ключ, но и на каждую колонку
 * сортировки — и точно так же безусловно. Колонка связи, присоединённой ради `$orderby`,
 * в выборку не попадала, и запрос падал (`no such column: distinctAlias.Author_books_pages`).
 * Теперь такие колонки дописываются в выборку и убираются из ответа.
 */
describe('$orderby по колонке вне выборки вместе с пагинацией (A-18)', () => {
  it('сортировка по полю связи без $expand', async () => {
    const result = await rows(
      dataSource.getRepository(Author),
      { $orderby: 'books/pages asc', $top: '2' },
      'Author'
    );

    expect(result).toHaveLength(2);
    // Связь присоединялась только ради сортировки — в ответе её быть не должно.
    expect(result.every((author) => !('books' in author))).toBe(true);
  });

  it('сортировка по полю связи через два уровня', async () => {
    const result = await rows(
      dataSource.getRepository(Author),
      { $orderby: 'books/reviews/score asc', $top: '2' },
      'Author'
    );

    expect(result).toHaveLength(2);
    expect(result.every((author) => !('books' in author))).toBe(true);
  });

  it('сортировка по колонке корня, не названной в $select', async () => {
    const result = await rows(
      dataSource.getRepository(Author),
      { $select: 'name', $expand: 'books', $orderby: 'age asc', $top: '2' },
      'Author'
    );

    expect(result.map((author) => author.name)).toEqual(['Barbara', 'Ada']);
    // `age` добавлялась ради сортировки и в ответ попасть не должна.
    expect(Object.keys(result[0]!).sort()).toEqual(['books', 'name']);
  });

  it('вложенный $orderby по колонке вне вложенного $select', async () => {
    const result = await rows(
      dataSource.getRepository(Author),
      {
        $expand: 'books($select=title;$orderby=pages asc)',
        $select: 'name',
        $orderby: 'name asc',
        $top: '3',
      },
      'Author'
    );

    const books = result.flatMap((author) => author.books);

    expect(books.length).toBeGreaterThan(0);
    // `pages` дописывалась ради сортировки связи — в книгах остаётся только запрошенное.
    expect(books.every((book) => Object.keys(book).length === 1 && 'title' in book)).toBe(true);
  });

  it('сортировка по псевдониму $compute вместе с соединением', async () => {
    // Выражение в ORDER BY TypeORM читает как `алиас.колонка` и отказывается строить запрос,
    // поэтому в сортировку уходит SQL-псевдоним, а выражение — в SELECT.
    const result = await rows(
      dataSource.getRepository(Author),
      { $compute: 'age mul -1 as inverted', $orderby: 'inverted asc', $expand: 'books', $top: '2' },
      'Author'
    );

    expect(result.map((author) => author.id)).toEqual([2, 3]);
    // Псевдоним в $select не назывался — свойства в ответе быть не должно.
    expect(result.every((author) => !('inverted' in author))).toBe(true);
  });

  it('сортировка по псевдониму $compute внутри $expand упорядочивает связь', async () => {
    const result = await rows(
      dataSource.getRepository(Author),
      {
        $expand: 'books($compute=pages mul -1 as inverted;$orderby=inverted asc)',
        $select: 'id',
        $orderby: 'id asc',
      },
      'Author'
    );

    // У Ada книги идут по убыванию страниц: 300, затем 120.
    expect(result[0]!.books.map((book) => book.pages)).toEqual([300, 120]);
  });

  it('тот же запрос вместе с пагинацией корня выполняется', async () => {
    // Проверяется именно выполнимость: раньше запрос отвергался самим TypeORM
    // (`"(Author_books" alias was not found`), потому что в ORDER BY уходило выражение.
    //
    // Число корневых строк здесь не проверяется намеренно: вложенная сортировка по связи
    // «ко многим» вместе с `$top` корня возвращает их меньше запрошенного — это отдельное
    // ограничение двухшаговой пагинации, не зависящее от `$compute`; см. соседний тест.
    const result = await rows(
      dataSource.getRepository(Author),
      {
        $expand: 'books($compute=pages mul -1 as inverted;$orderby=inverted asc)',
        $select: 'id',
        $orderby: 'id asc',
        $top: '2',
      },
      'Author'
    );

    expect(result.length).toBeGreaterThan(0);
    expect(result[0]!.id).toBe(1);
  });

  it('вложенная сортировка по связи «ко многим» вместе с $top корня режет страницу по строкам', async () => {
    // ОГРАНИЧЕНИЕ, А НЕ ОЖИДАЕМОЕ ПОВЕДЕНИЕ. При пагинации с соединением TypeORM выбирает
    // страницу подзапросом `SELECT DISTINCT <ключ>, <колонки сортировки>`: колонка связи
    // «ко многим» размножает строки, и `LIMIT` отсчитывает их, а не корневые сущности.
    // У Ada две книги, поэтому `$top=2` отдаёт одного автора вместо двух.
    //
    // От `$compute` не зависит — то же самое даёт обычная вложенная сортировка. Тест
    // фиксирует факт, чтобы расхождение не считалось нормой и было видно при починке.
    const withNestedOrder = await rows(
      dataSource.getRepository(Author),
      { $expand: 'books($orderby=pages desc)', $select: 'id', $orderby: 'id asc', $top: '2' },
      'Author'
    );

    const withoutNestedOrder = await rows(
      dataSource.getRepository(Author),
      { $expand: 'books', $select: 'id', $orderby: 'id asc', $top: '2' },
      'Author'
    );

    expect(withoutNestedOrder.map((author) => author.id)).toEqual([1, 2]);
    expect(withNestedOrder.map((author) => author.id)).toEqual([1]);
  });

  it('без пагинации поведение прежнее — лишних колонок в ответе не появляется', async () => {
    const result = await rows(
      dataSource.getRepository(Author),
      { $select: 'name', $orderby: 'books/pages asc' },
      'Author'
    );

    expect(result.every((author) => Object.keys(author).length === 1)).toBe(true);
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
   * OData v4, раздел 11.2.5.5: отсутствующий `$count` эквивалентен `$count=false`.
   * До версии 2.0.0 библиотека отступала от этого и возвращала `{ items, count }`
   * на каждый запрос, попутно выполняя лишний `COUNT(*)`. Тест закрепляет исправленное
   * поведение, чтобы отступление не вернулось незаметно.
   */
  it('без $count возвращает массив, а не объект со счётчиком', async () => {
    const result = await executeQuery(dataSource.getRepository(Author), {}, { alias: 'Author' });

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(4);
    expect(result).not.toHaveProperty('count');
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
    expect(result[0]!.books.map((b) => b.id).sort()).toEqual([1, 2]);
  });

  it('загружает связь many-to-one', async () => {
    const result = await rows(
      dataSource.getRepository(Book),
      { $expand: 'author', $filter: 'id eq 1' },
      'Book'
    );

    expect(result[0]!.author?.name).toBe('Ada');
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

    expect(Object.keys(result[0]!.books[0]!).sort()).toEqual(['id', 'title']);
  });

  it('вложенный $orderby сортирует связанные записи', async () => {
    const result = await rows(
      dataSource.getRepository(Author),
      { $expand: 'books($orderby=id desc)', $filter: "name eq 'Ada'" },
      'Author'
    );

    expect(result[0]!.books.map((b) => b.id)).toEqual([2, 1]);
  });

  it('вложенный $expand второго уровня', async () => {
    const result = await rows(
      dataSource.getRepository(Author),
      { $expand: 'books($expand=reviews)', $filter: "name eq 'Ada'" },
      'Author'
    );

    const firstBook = result[0]!.books.find((b) => b.id === 1);

    expect(firstBook?.reviews.map((r) => r.id).sort()).toEqual([1, 2]);
  });

  it('несколько связей одновременно', async () => {
    const result = await rows(
      dataSource.getRepository(Book),
      { $expand: 'author,reviews', $filter: 'id eq 1' },
      'Book'
    );

    expect(result[0]!.author?.name).toBe('Ada');
    expect(result[0]!.reviews).toHaveLength(2);
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
    expect(Object.keys(result[0]!.books[0]!).sort()).toEqual(['id', 'title']);
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

/**
 * Грамматика `$search` по OData v4 (раздел 5.1.7).
 *
 * До версии 2.0.0 строка бралась целиком и искалась как одна подстрока: `$search=ada OR grace`
 * искал текст «ada OR grace» и не находил ничего. Молчаливое расхождение с запросом.
 *
 * Данные: Ada (bio «Pioneer of computing»), Grace (bio пустая), Alan (bio «Codebreaker»),
 * Barbara (bio пустая).
 */
describe('$search — грамматика', () => {
  const cases: readonly MatrixCase[] = [
    { name: 'OR объединяет', query: { $search: 'ada OR alan' }, expected: [1, 3] },
    { name: 'явный AND', query: { $search: 'pioneer AND computing' }, expected: [1] },
    {
      name: 'пробел между словами — тоже AND',
      query: { $search: 'pioneer computing' },
      expected: [1],
    },
    { name: 'AND по разным колонкам одной строки', query: { $search: 'ada 36' }, expected: [1] },
    { name: 'слова, которых нет вместе', query: { $search: 'pioneer codebreaker' }, expected: [] },
    { name: 'фраза целиком', query: { $search: '"pioneer of computing"' }, expected: [1] },
    { name: 'фразы нет — слова есть', query: { $search: '"computing pioneer"' }, expected: [] },
    { name: 'скобки меняют приоритет', query: { $search: '(ada OR alan) 41' }, expected: [3] },
    { name: 'NOT перед скобкой', query: { $search: 'NOT (ada OR alan)' }, expected: [2, 4] },
    {
      name: 'AND сильнее OR',
      // ada OR (alan AND codebreaker)
      query: { $search: 'ada OR alan codebreaker' },
      expected: [1, 3],
    },
    {
      name: 'строчное and — обычное слово, а не оператор',
      query: { $search: 'and' },
      expected: [],
    },
  ];

  runMatrix(authorIds, cases);

  /**
   * Ключевой случай для проверок на NULL: у Grace и Barbara пустая `bio`. Без защиты
   * `IS NOT NULL` условие по такой колонке давало бы `NULL`, а `NOT NULL` — снова `NULL`,
   * и обе строки выпали бы из выдачи, хотя «не содержит ada» для них верно.
   */
  it('NOT оставляет строки с пустыми колонками', async () => {
    expect((await authorIds({ $search: 'NOT ada' })).sort()).toEqual([2, 3, 4]);
  });

  it('% и _ ищутся буквально, а не как шаблон', async () => {
    // Ни у кого в данных нет процента, а как шаблон LIKE '%%%' совпал бы со всеми.
    expect(await authorIds({ $search: '%' })).toEqual([]);
    expect(await authorIds({ $search: '_' })).toEqual([]);
  });

  it('синтаксическая ошибка отвергается, а не ищется как текст', async () => {
    const error = await expectRejected(authorIds, { $search: '(ada' });

    expect(error).toBeInstanceOf(ODataInvalidQueryError);
  });
});

/**
 * `searchFields`: по каким полям искать.
 *
 * По умолчанию поиск идёт по всем скалярным колонкам корня — на публичном API это и медленно,
 * и опасно: перебором строки поиска клиент выясняет содержимое полей, которые ему не показывают.
 */
describe('$search — searchFields', () => {
  const authors = (query: QueryParams, fields: string[]) =>
    rows(dataSource.getRepository(Author), query, 'Author', { searchFields: fields }).then((r) =>
      r.map((author) => author.id).sort()
    );

  const books = (query: QueryParams, fields: string[]) =>
    rows(dataSource.getRepository(Book), query, 'Book', { searchFields: fields }).then((r) =>
      r.map((book) => book.id).sort()
    );

  it('сужает поиск до перечисленных полей корня', async () => {
    expect(await authors({ $search: 'ada' }, ['name'])).toEqual([1]);
    // В bio слова «ada» нет ни у кого — значит колонка name в поиске не участвовала.
    expect(await authors({ $search: 'ada' }, ['bio'])).toEqual([]);
  });

  it('ищет по полю связи «многие к одному»', async () => {
    expect(await books({ $search: 'ada' }, ['author/name'])).toEqual([1, 2]);
  });

  it('ищет по полю связи «один ко многим», не размножая корневые строки', async () => {
    // У Ada две книги; автор обязан вернуться один раз, а не дважды.
    expect(await authors({ $search: 'engine OR numbers' }, ['books/title'])).toEqual([1]);
  });

  it('ищет по полю связи «многие ко многим»', async () => {
    expect(await books({ $search: 'classic' }, ['tags/label'])).toEqual([1, 3]);
  });

  it('ищет по цепочке из двух связей', async () => {
    expect(await authors({ $search: 'brilliant' }, ['books/reviews/text'])).toEqual([1]);
  });

  it('несколько полей объединяются через OR', async () => {
    expect(await books({ $search: 'ada OR classic' }, ['author/name', 'tags/label'])).toEqual([
      1, 2, 3,
    ]);
  });

  it('несуществующее поле — ошибка, а не молчаливый пропуск', async () => {
    await expect(authors({ $search: 'ada' }, ['nope'])).rejects.toBeInstanceOf(
      ODataInvalidQueryError
    );
  });
});

/**
 * Полнотекстовый режим `$search`.
 *
 * Прогоняется только на PostgreSQL: там `to_tsvector` работает и без индекса. В MySQL колонка
 * обязана входить в индекс `FULLTEXT`, а заводить его в общих фикстурах нельзя — SQLite такого
 * индекса не понимает, и общая схема перестала бы создаваться. Форма SQL для MySQL проверена
 * модульными тестами `processSearch`.
 */
describe('$search — режим fulltext', () => {
  const fulltextAuthors = (query: QueryParams) =>
    rows(dataSource.getRepository(Author), query, 'Author', { searchMode: 'fulltext' }).then((r) =>
      r.map((author) => author.id).sort()
    );

  const onlyPostgres = testDatabase === 'postgres' ? it : it.skip;

  onlyPostgres('слово ищется полнотекстовым индексом', async () => {
    expect(await fulltextAuthors({ $search: 'ada' })).toEqual([1]);
  });

  onlyPostgres('операторы работают так же, как в режиме like', async () => {
    expect(await fulltextAuthors({ $search: 'ada OR codebreaker' })).toEqual([1, 3]);
    expect(await fulltextAuthors({ $search: 'pioneer computing' })).toEqual([1]);
    expect(await fulltextAuthors({ $search: 'NOT (ada OR alan)' })).toEqual([2, 4]);
  });

  onlyPostgres('фраза учитывает порядок слов', async () => {
    expect(await fulltextAuthors({ $search: '"pioneer of computing"' })).toEqual([1]);
    expect(await fulltextAuthors({ $search: '"computing pioneer"' })).toEqual([]);
  });

  onlyPostgres('ищутся слова целиком, а не подстроки', async () => {
    // Ключевое отличие от режима like: «ad» — не слово, а начало слова.
    expect(await fulltextAuthors({ $search: 'ad' })).toEqual([]);
    expect(await rows(dataSource.getRepository(Author), { $search: 'ad' }, 'Author')).toHaveLength(
      1
    );
  });

  it('на SQLite и MS SQL режим молча остаётся like', async () => {
    // Иначе один и тот же код падал бы на SQLite в разработке и работал на PostgreSQL.
    if (testDatabase === 'postgres' || testDatabase === 'mysql') {
      return;
    }

    expect(await fulltextAuthors({ $search: 'ad' })).toEqual([1]);
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
    expect(Object.keys(result[0]!).sort()).toEqual(['id', 'name']);
  });

  it('$expand + $filter по корню + пагинация', async () => {
    const result = await rows(
      dataSource.getRepository(Author),
      { $expand: 'books', $filter: 'isActive eq true', $orderby: 'id asc', $top: '2' },
      'Author'
    );

    expect(result.map((r) => r.id)).toEqual([1, 2]);
    expect(result[0]!.books).toHaveLength(2);
  });
});

/**
 * Вложенная пагинация внутри `$expand`.
 *
 * Раньше `$expand=books($top=1)` разбирался, но `limit` / `skip` дочернего посетителя нигде
 * не читались — возвращались все связанные записи. Молчаливое расхождение с запросом:
 * клиент просил одну книгу, получал все.
 *
 * Страницу вырезает SQL: к условию соединения дописывается оконная функция, нумерующая
 * связанные строки внутри каждого родителя. Там, где так сделать нельзя, срез делается
 * над деревом сущностей — оба пути обязаны давать один и тот же результат, что и проверяется
 * отдельным блоком ниже.
 */
describe('$expand — вложенная пагинация', () => {
  it('вложенный $top ограничивает число связанных записей', async () => {
    const result = await rows(
      dataSource.getRepository(Author),
      { $expand: 'books($top=1;$orderby=id asc)', $filter: "name eq 'Ada'" },
      'Author'
    );

    expect(result[0]!.books.map((b) => b.id)).toEqual([1]);
  });

  it('вложенный $skip пропускает начало коллекции', async () => {
    const result = await rows(
      dataSource.getRepository(Author),
      { $expand: 'books($skip=1;$orderby=id asc)', $filter: "name eq 'Ada'" },
      'Author'
    );

    expect(result[0]!.books.map((b) => b.id)).toEqual([2]);
  });

  it('вложенные $top и $skip работают вместе', async () => {
    const result = await rows(
      dataSource.getRepository(Author),
      { $expand: 'books($top=1;$skip=1;$orderby=id asc)', $filter: "name eq 'Ada'" },
      'Author'
    );

    expect(result[0]!.books.map((b) => b.id)).toEqual([2]);
  });

  it('вложенный $top=0 даёт пустую коллекцию', async () => {
    const result = await rows(
      dataSource.getRepository(Author),
      { $expand: 'books($top=0)', $filter: "name eq 'Ada'" },
      'Author'
    );

    expect(result[0]!.books).toEqual([]);
  });

  it('срез применяется к каждому родителю независимо', async () => {
    const result = await rows(
      dataSource.getRepository(Author),
      { $expand: 'books($top=1;$orderby=id asc)', $orderby: 'id asc' },
      'Author'
    );

    // У Ada две книги, у Grace и Alan по одной, у Barbara ни одной.
    expect(result.map((a) => a.books.length)).toEqual([1, 1, 1, 0]);
  });

  it('вложенный $orderby применяется до среза', async () => {
    const result = await rows(
      dataSource.getRepository(Author),
      { $expand: 'books($top=1;$orderby=id desc)', $filter: "name eq 'Ada'" },
      'Author'
    );

    // При сортировке по убыванию первой оказывается вторая книга
    expect(result[0]!.books.map((b) => b.id)).toEqual([2]);
  });

  it('срез работает на втором уровне вложенности', async () => {
    const result = await rows(
      dataSource.getRepository(Author),
      { $expand: 'books($expand=reviews($top=1;$orderby=id asc))', $filter: "name eq 'Ada'" },
      'Author'
    );

    const firstBook = result[0]!.books.find((b) => b.id === 1);

    // У первой книги два отзыва, остаться должен один
    expect(firstBook?.reviews.map((r) => r.id)).toEqual([1]);
  });

  it('связь без ограничений возвращается целиком', async () => {
    const result = await rows(
      dataSource.getRepository(Author),
      { $expand: 'books', $filter: "name eq 'Ada'" },
      'Author'
    );

    expect(result[0]!.books).toHaveLength(2);
  });

  it('$count считает корневые сущности, а не связанные', async () => {
    const result = await executeQuery(
      dataSource.getRepository(Author),
      { $expand: 'books($top=1)', $count: 'true' },
      { alias: 'Author' }
    );

    expect((result as { count: number }).count).toBe(4);
  });

  it('страница считается после вложенного $filter, а не до него', async () => {
    const result = await rows(
      dataSource.getRepository(Author),
      { $expand: 'books($filter=pages lt 200;$top=1;$orderby=id asc)', $filter: "name eq 'Ada'" },
      'Author'
    );

    // У Ada книги 1 (300 страниц) и 2 (120). Под фильтр подходит только вторая, она же
    // и обязана оказаться первой страницей. Если бы строки нумеровались до фильтра,
    // в страницу попала бы книга 1 и после отбора коллекция осталась бы пустой.
    expect(result[0]!.books.map((b) => b.id)).toEqual([2]);
  });
});

/**
 * Вложенная пагинация на связи «многие ко многим».
 *
 * Отдельный блок, потому что случай принципиально другой: у связанной строки нет внешнего
 * ключа на родителя — одна и та же метка принадлежит нескольким книгам и в разных книгах
 * попадает в разные страницы. Нумеровать поэтому приходится строки таблицы связей,
 * а условие связывать сразу с двумя ключами.
 *
 * Данные: у книги 1 метки 1 и 2, у книги 2 — метка 2, у книги 3 — метки 1 и 3,
 * у книги 4 — метка 3, книга 5 не помечена.
 */
describe('$expand — вложенная пагинация «многие ко многим»', () => {
  it('вложенный $top ограничивает метки каждой книги отдельно', async () => {
    const result = await rows(
      dataSource.getRepository(Book),
      { $expand: 'tags($top=1;$orderby=id asc)', $orderby: 'id asc' },
      'Book'
    );

    expect(result.map((book) => book.tags.map((tag) => tag.id))).toEqual([[1], [2], [1], [3], []]);
  });

  it('вложенный $skip пропускает начало коллекции у каждой книги', async () => {
    const result = await rows(
      dataSource.getRepository(Book),
      { $expand: 'tags($skip=1;$orderby=id asc)', $orderby: 'id asc' },
      'Book'
    );

    expect(result.map((book) => book.tags.map((tag) => tag.id))).toEqual([[2], [], [3], [], []]);
  });

  it('та же связь с обратной стороны', async () => {
    const result = await rows(
      dataSource.getRepository(Tag),
      { $expand: 'books($top=1;$orderby=id asc)', $orderby: 'id asc' },
      'Tag'
    );

    // Метка 1 стоит у книг 1 и 3, метка 2 — у 1 и 2, метка 3 — у 3 и 4, метка 4 не стоит нигде.
    expect(result.map((tag) => tag.books.map((book) => book.id))).toEqual([[1], [1], [3], []]);
  });

  it('одна метка попадает в страницы разных книг независимо', async () => {
    const result = await rows(
      dataSource.getRepository(Book),
      { $expand: 'tags($skip=1;$top=1;$orderby=id desc)', $orderby: 'id asc' },
      'Book'
    );

    // Метка 1 у книги 1 вторая по убыванию, у книги 3 — тоже вторая. Обе страницы
    // считаются от своего родителя, а не от общего списка меток.
    expect(result.map((book) => book.tags.map((tag) => tag.id))).toEqual([[1], [], [1], [], []]);
  });
});

/**
 * Перенос среза в SQL: и что он происходит, и что его можно выключить.
 *
 * Результат у обеих стратегий одинаковый по построению, поэтому по данным их не различить —
 * проверяется сам сгенерированный запрос.
 */
describe('$expand — где выполняется вложенная пагинация', () => {
  it('срез уходит в SQL оконной функцией — там, где СУБД считает окно верно', async () => {
    const { lastSql } = await captureSql(() =>
      rows(dataSource.getRepository(Author), { $expand: 'books($top=1;$orderby=id asc)' }, 'Author')
    );

    if (pushdown) {
      expect(lastSql).toContain('ROW_NUMBER() OVER (PARTITION BY');
    } else {
      // MySQL вычисляет окно после наложения внешнего условия, поэтому страницу там
      // режет applyNestedPagination — см. supportsNestedPagePushdown.
      expect(lastSql).not.toContain('ROW_NUMBER');
    }
  });

  it('опция nestedPaginationInSql: false возвращает срез в память', async () => {
    const { lastSql } = await captureSql(() =>
      rows(
        dataSource.getRepository(Author),
        { $expand: 'books($top=1;$orderby=id asc)' },
        'Author',
        { nestedPaginationInSql: false }
      )
    );

    expect(lastSql).not.toContain('ROW_NUMBER');
  });

  it('сортировка по соседней связи выполняется срезом в памяти', async () => {
    const { lastSql, result } = await captureSql(() =>
      rows(
        dataSource.getRepository(Author),
        { $expand: 'books($top=1;$orderby=category/name asc)', $filter: "name eq 'Ada'" },
        'Author'
      )
    );

    // Алиаса раздела в подзапросе не существует, поэтому условие не строится.
    expect(lastSql).not.toContain('ROW_NUMBER');
    // Ada: книга 1 в разделе Computing, книга 2 — в Mathematics.
    expect(result[0]!.books.map((book) => book.id)).toEqual([1]);
  });

  it('обе стратегии дают одинаковый результат', async () => {
    const queries: QueryParams[] = [
      { $expand: 'books($top=1;$orderby=id asc)', $orderby: 'id asc' },
      { $expand: 'books($skip=1;$orderby=id asc)', $orderby: 'id asc' },
      { $expand: 'books($top=1;$skip=1;$orderby=id desc)', $orderby: 'id asc' },
      { $expand: 'books($top=0)', $orderby: 'id asc' },
      { $expand: 'books($filter=pages gt 100;$top=1;$orderby=id asc)', $orderby: 'id asc' },
      { $expand: 'books($expand=reviews($top=1;$orderby=id asc))', $orderby: 'id asc' },
    ];

    for (const query of queries) {
      const repository = dataSource.getRepository(Author);
      const inSql = await rows(repository, query, 'Author');
      const inMemory = await rows(repository, query, 'Author', { nestedPaginationInSql: false });

      const shape = (authors: Author[]) =>
        authors.map((author) => [
          author.id,
          author.books.map((book) => [book.id, (book.reviews ?? []).map((review) => review.id)]),
        ]);

      expect(shape(inSql)).toEqual(shape(inMemory));
    }
  });
});

/**
 * Дефект A-14: сортировка связи попадала в `ORDER BY` раньше корневой и начинала
 * управлять порядком корневых строк.
 *
 * Результат запроса с `LEFT JOIN` плоский, поэтому очерёдность выражений в `ORDER BY`
 * определяет всё. `processIncludes` вызывался до применения корневого `$orderby`,
 * и авторы без книг всплывали наверх — у них значение поля связи NULL.
 */
describe('приоритет сортировки при $expand', () => {
  it('корневой $orderby главнее сортировки связи', async () => {
    const result = await rows(
      dataSource.getRepository(Author),
      { $expand: 'books($orderby=id asc)', $orderby: 'id asc' },
      'Author'
    );

    expect(result.map((a) => a.id)).toEqual([1, 2, 3, 4]);
  });

  it('автор без связанных записей не всплывает наверх', async () => {
    const result = await rows(
      dataSource.getRepository(Author),
      { $expand: 'books($orderby=id asc)', $orderby: 'id asc' },
      'Author'
    );

    // Barbara (id 4) книг не имеет и обязана остаться последней
    expect(result[result.length - 1]!.id).toBe(4);
    expect(result[result.length - 1]!.books).toEqual([]);
  });

  it('сортировка связи по-прежнему упорядочивает записи внутри родителя', async () => {
    const result = await rows(
      dataSource.getRepository(Author),
      { $expand: 'books($orderby=id desc)', $orderby: 'id asc' },
      'Author'
    );

    expect(result[0]!.id).toBe(1);
    expect(result[0]!.books.map((b) => b.id)).toEqual([2, 1]);
  });

  it('обе сортировки работают вместе со срезом связи', async () => {
    const result = await rows(
      dataSource.getRepository(Author),
      { $expand: 'books($orderby=id desc;$top=1)', $orderby: 'id desc' },
      'Author'
    );

    expect(result.map((a) => a.id)).toEqual([4, 3, 2, 1]);
    // У Ada из двух книг остаётся последняя по возрастанию id
    expect(result[result.length - 1]!.books.map((b) => b.id)).toEqual([2]);
  });
});
