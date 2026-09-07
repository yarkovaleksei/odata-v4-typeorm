/**
 * @file Матрица: `$count` внутри `$expand`.
 *
 * Счётчик приходит аннотацией рядом со связью — `books@odata.count`, — поэтому проверять
 * его нужно на реальной БД: значение считает СУБД скалярным подзапросом, а не библиотека
 * над уже загруженным деревом.
 *
 * Ключевое свойство, ради которого написан почти каждый случай ниже: счётчик считает
 * **всю** связь после вложенного `$filter`, но до вложенных `$top` / `$skip`. Иначе
 * `$expand=books($top=1;$count=true)` отвечал бы «книга одна» на любого автора, и опция
 * стала бы бессмысленной.
 *
 * Фикстуры: у Ada(1) две книги, у Grace(2) и Alan(3) — по одной, у Barbara(4) книг нет.
 */
import { executeQuery, ODataInvalidQueryError, ODataUnsupportedError } from '../../lib';
import { Author, Book } from '../fixtures';
import { dataSource } from '../setup/dataSource';
import { expectRejected, rows } from './helpers';

/** Счётчик связи у сущности. `undefined` означает, что аннотации в ответе нет вовсе. */
function countOf(entity: object, relation: string): unknown {
  return (entity as Record<string, unknown>)[`${relation}@odata.count`];
}

/** Авторы по возрастанию id вместе со счётчиком книг. */
async function authorsWithBookCount(
  query: Record<string, string>
): Promise<Array<{ id: number; books: number; count: unknown }>> {
  const result = await rows(
    dataSource.getRepository(Author),
    { $orderby: 'id asc', ...query },
    'Author'
  );

  return result.map((author) => ({
    id: author.id,
    books: author.books?.length ?? 0,
    count: countOf(author, 'books'),
  }));
}

describe('$count внутри $expand', () => {
  it('считает связанные строки для каждого родителя', async () => {
    expect(await authorsWithBookCount({ $expand: 'books($count=true)' })).toEqual([
      { id: 1, books: 2, count: 2 },
      { id: 2, books: 1, count: 1 },
      { id: 3, books: 1, count: 1 },
      // Автор без книг: LEFT JOIN оставляет его в выдаче, и ноль обязан быть числом,
      // а не отсутствующим свойством — иначе клиент не отличит «нет книг» от «не считали».
      { id: 4, books: 0, count: 0 },
    ]);
  });

  it('не меняет форму самой связи', async () => {
    const [ada] = await rows(
      dataSource.getRepository(Author),
      { $filter: 'id eq 1', $expand: 'books($count=true)' },
      'Author'
    );

    expect(Array.isArray(ada?.books)).toBe(true);
    expect(ada?.books.map((book) => book.id).sort()).toEqual([1, 2]);
  });

  /**
   * Главный случай: страница связи вырезана, а счётчик показывает полное число.
   * Ровно ради него `$count` внутри `$expand` и просят — «показать первые N из M».
   */
  it('игнорирует вложенный $top', async () => {
    expect(
      await authorsWithBookCount({ $expand: 'books($orderby=id asc;$top=1;$count=true)' })
    ).toEqual([
      { id: 1, books: 1, count: 2 },
      { id: 2, books: 1, count: 1 },
      { id: 3, books: 1, count: 1 },
      { id: 4, books: 0, count: 0 },
    ]);
  });

  it('игнорирует вложенный $skip', async () => {
    expect(
      await authorsWithBookCount({ $expand: 'books($orderby=id asc;$skip=1;$count=true)' })
    ).toEqual([
      { id: 1, books: 1, count: 2 },
      { id: 2, books: 0, count: 1 },
      { id: 3, books: 0, count: 1 },
      { id: 4, books: 0, count: 0 },
    ]);
  });

  /** А вот вложенный `$filter` счётчик обязан учитывать: он сужает саму коллекцию. */
  it('учитывает вложенный $filter', async () => {
    expect(
      await authorsWithBookCount({ $expand: 'books($filter=pages gt 200;$count=true)' })
    ).toEqual([
      // У Ada две книги, но 300 и 120 страниц — под условие подходит одна.
      { id: 1, books: 1, count: 1 },
      { id: 2, books: 1, count: 1 },
      { id: 3, books: 1, count: 1 },
      { id: 4, books: 0, count: 0 },
    ]);
  });

  it('работает со связью «многие ко многим»', async () => {
    const result = await rows(
      dataSource.getRepository(Book),
      { $orderby: 'id asc', $expand: 'tags($count=true)' },
      'Book'
    );

    expect(result.map((book) => countOf(book, 'tags'))).toEqual([2, 1, 2, 1, 0]);
  });

  /**
   * Две коллекции одной сущности: у книги 1 два отзыва (1, 2) и две метки
   * (classic, reference). Числа намеренно совпадают не везде — на книге 2 отзыв один,
   * а метка тоже одна, поэтому берётся именно первая, где счётчики независимы по смыслу.
   */
  it('считает независимо для нескольких связей сразу', async () => {
    const [first] = await rows(
      dataSource.getRepository(Book),
      { $filter: 'id eq 3', $expand: 'reviews($count=true),tags($count=true)' },
      'Book'
    );

    // У книги 3 один отзыв (4) и две метки (classic, history).
    expect(countOf(first as object, 'reviews')).toBe(1);
    expect(countOf(first as object, 'tags')).toBe(2);
  });

  /**
   * Счётчик — аннотация, а не поле, поэтому `$select` его не убирает: клиент не называл
   * его в `$select` и назвать не может. Заодно проверяется, что первичный ключ, дописанный
   * ради сопоставления «сырых» строк с сущностями, из ответа снят.
   */
  it('приходит и при $select, не называющем ключ', async () => {
    const [ada] = await rows(
      dataSource.getRepository(Author),
      { $filter: 'id eq 1', $select: 'name', $expand: 'books($count=true)' },
      'Author'
    );

    expect(Object.keys(ada as object).sort()).toEqual(['books', 'books@odata.count', 'name']);
    expect(countOf(ada as object, 'books')).toBe(2);
  });

  it('сочетается с корневым $count и страницей', async () => {
    const result = await executeQuery(
      dataSource.getRepository(Author),
      { $expand: 'books($count=true)', $orderby: 'id asc', $top: '2', $count: 'true' },
      { alias: 'Author' }
    );

    expect(Array.isArray(result)).toBe(false);

    const page = result as { items: Author[]; count: number };

    expect(page.count).toBe(4);
    expect(page.items.map((author) => countOf(author, 'books'))).toEqual([2, 1]);
  });

  /**
   * Оба значения приходят из одного «сырого» результата и раскладываются по сущностям
   * одним проходом, поэтому важно, что они не мешают друг другу.
   *
   * Заодно виден и намеренный разнобой в приведении типа: счётчик библиотека приводит
   * к числу сама (величина одна и та же на всех СУБД, разнится только драйвер), а значение
   * `$compute` — нет, потому что его тип задаёт выражение и знать его библиотеке неоткуда:
   * в MySQL `age mul 2` приходит строкой. Отсюда `Number()` на одном и его отсутствие
   * на другом — см. odata-support.md.
   */
  it('сочетается с $compute в $select', async () => {
    const [ada] = await rows(
      dataSource.getRepository(Author),
      {
        $filter: 'id eq 1',
        $compute: 'age mul 2 as doubled',
        $select: 'id,doubled',
        $expand: 'books($count=true)',
      },
      'Author'
    );

    expect(Number((ada as unknown as { doubled: unknown }).doubled)).toBe(72);
    expect(countOf(ada as object, 'books')).toBe(2);
  });

  /**
   * Тип значения проверяется отдельно от самого числа: `COUNT(*)` в MySQL — это `BIGINT`,
   * и драйвер отдаёт его строкой. Корневой `count` при этом число, и расхождение между
   * ними означало бы, что одна и та же величина приходит по-разному в зависимости от того,
   * где её запросили.
   */
  it('приходит числом, а не строкой', async () => {
    const [ada] = await rows(
      dataSource.getRepository(Author),
      { $filter: 'id eq 1', $expand: 'books($count=true)' },
      'Author'
    );

    expect(typeof countOf(ada as object, 'books')).toBe('number');
  });

  it('без $count=true аннотации в ответе нет', async () => {
    const [ada] = await rows(
      dataSource.getRepository(Author),
      { $filter: 'id eq 1', $expand: 'books' },
      'Author'
    );

    expect(countOf(ada as object, 'books')).toBeUndefined();
  });

  it('$count=false равнозначен отсутствию опции', async () => {
    const [ada] = await rows(
      dataSource.getRepository(Author),
      { $filter: 'id eq 1', $expand: 'books($count=false)' },
      'Author'
    );

    expect(countOf(ada as object, 'books')).toBeUndefined();
  });
});

describe('$count внутри $expand: что отвергается', () => {
  /**
   * Считать нечего: у связи «к одному» либо одна запись, либо ни одной, и это видно
   * по самому ответу. Молча проигнорировать опцию нельзя — клиент решил бы, что счётчик
   * просто не поддержан, и не узнал бы, что запрос выполнен не так, как написан.
   */
  it('$count у связи «к одному»', async () => {
    const error = await expectRejected(
      (query) => executeQuery(dataSource.getRepository(Book), query, { alias: 'Book' }),
      { $expand: 'author($count=true)' }
    );

    expect(error).toBeInstanceOf(ODataInvalidQueryError);
    expect(error.message).toContain('author');
  });

  it('$count глубже первого уровня $expand', async () => {
    const error = await expectRejected(
      (query) => executeQuery(dataSource.getRepository(Author), query, { alias: 'Author' }),
      { $expand: 'books($expand=reviews($count=true))' }
    );

    expect(error).toBeInstanceOf(ODataUnsupportedError);
    expect(error.message).toContain('books/reviews');
  });

  it('$count на третьем уровне тоже отвергается', async () => {
    const error = await expectRejected(
      (query) => executeQuery(dataSource.getRepository(Author), query, { alias: 'Author' }),
      { $expand: 'books($expand=reviews($expand=user($count=true)))' }
    );

    expect(error).toBeInstanceOf(ODataUnsupportedError);
    expect(error.message).toContain('books/reviews/user');
  });
});
