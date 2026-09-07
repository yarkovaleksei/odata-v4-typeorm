/**
 * @file Матрица: первичный ключ UUID.
 *
 * В реальных базах числовой автоинкремент — далеко не единственный вид ключа, а путь
 * «строковый ключ» проходит через другие места библиотеки: литерал в `$filter` разбирается
 * как строка, внешний ключ в JOIN сравнивается со строкой, а тип колонки у каждой СУБД
 * свой — в PostgreSQL это настоящий `uuid`, в MySQL и SQLite `varchar(36)`.
 *
 * Ключ UUID носят две сущности фикстур:
 *
 * | Сущность | Роль ключа |
 * |---|---|
 * | {@link Publisher} | сторона «один» обязательной связи `Book.publisher` |
 * | {@link BookDetails} | владеющая сторона связи «один к одному» |
 *
 * Ссылки на них остаются вперемешку с числовыми (`book.author_id` — число,
 * `book.publisher_id` — UUID), то есть проверяется именно смешанная схема.
 */
import { Book, BookDetails, BOOK_DETAILS_IDS, Publisher, PUBLISHER_IDS } from '../fixtures';
import { dataSource } from '../setup/dataSource';
import { rows } from './helpers';

const publishers = (query: Parameters<typeof rows>[1]) =>
  rows<Publisher>(dataSource.getRepository(Publisher), query, 'Publisher');

const books = (query: Parameters<typeof rows>[1]) =>
  rows<Book>(dataSource.getRepository(Book), query, 'Book');

const details = (query: Parameters<typeof rows>[1]) =>
  rows<BookDetails>(dataSource.getRepository(BookDetails), query, 'BookDetails');

describe('фикстуры и объявленные идентификаторы не разошлись', () => {
  // Единственная защита от того, что правка seed.sql оставит в ids.ts старые значения:
  // тогда все остальные проверки продолжили бы искать несуществующие строки и падать
  // непонятно почему — а здесь расхождение видно сразу и в одном месте.
  it('издательства лежат под объявленными UUID', async () => {
    const result = await dataSource.getRepository(Publisher).find();

    expect(result.map((publisher) => publisher.id).sort()).toEqual(
      Object.values(PUBLISHER_IDS).slice().sort()
    );
  });

  it('выходные данные лежат под объявленными UUID', async () => {
    const result = await dataSource.getRepository(BookDetails).find();

    expect(result.map((item) => item.id).sort()).toEqual(
      Object.values(BOOK_DETAILS_IDS).slice().sort()
    );
  });
});

describe('запросы по ключу UUID', () => {
  it('$filter по ключу находит строку', async () => {
    const result = await publishers({ $filter: `id eq '${PUBLISHER_IDS.mit}'` });

    expect(result.map((publisher) => publisher.name)).toEqual(['MIT Press']);
  });

  it('$filter по ключу с неизвестным UUID даёт пустую выборку, а не ошибку', async () => {
    const result = await publishers({
      $filter: "id eq '00000000-0000-4000-8000-000000000000'",
    });

    expect(result).toEqual([]);
  });

  it('$orderby по ключу упорядочивает одинаково на всех СУБД', async () => {
    // Текстовая запись UUID — hex фиксированной длины в нижнем регистре, поэтому
    // лексикографический порядок (MySQL, SQLite) совпадает с побайтовым (PostgreSQL).
    const result = await publishers({ $orderby: 'id asc' });

    expect(result.map((publisher) => publisher.id)).toEqual([
      PUBLISHER_IDS.clarendon,
      PUBLISHER_IDS.mit,
      PUBLISHER_IDS.manning,
    ]);
  });

  it('$select отдаёт ключ строкой', async () => {
    const result = await publishers({ $select: 'id,name', $filter: "name eq 'MIT Press'" });

    expect(result[0]).toEqual({ id: PUBLISHER_IDS.mit, name: 'MIT Press' });
  });

  it('$search не ломается о колонку с UUID', async () => {
    // `uuid` не входит в список текстовых типов `processSearch`, поэтому ключ в поиск
    // не попадает ни на одной СУБД. Это важно именно для PostgreSQL: там колонка
    // действительно типа `uuid`, и `LOWER(id) LIKE …` дало бы ошибку уровня СУБД.
    const result = await publishers({ $search: 'Press' });

    expect(result.map((publisher) => publisher.name).sort()).toEqual([
      'Clarendon Press',
      'MIT Press',
    ]);
  });
});

describe('связи через ключ UUID', () => {
  it('фильтр по ключу связи', async () => {
    const result = await books({
      $filter: `publisher/id eq '${PUBLISHER_IDS.mit}'`,
      $orderby: 'id asc',
    });

    expect(result.map((book) => book.id)).toEqual([3, 4]);
  });

  it('$expand отдаёт связанную сущность с её UUID', async () => {
    const result = await books({ $expand: 'publisher', $filter: 'id eq 1' });

    expect(result[0]?.publisher.id).toBe(PUBLISHER_IDS.clarendon);
  });

  it('$expand с числового родителя на связь «один к одному» с UUID', async () => {
    const result = await books({ $expand: 'details', $filter: 'id eq 1' });

    expect(result[0]?.details?.id).toBe(BOOK_DETAILS_IDS.analyticalEngine);
  });

  it('фильтр по ключу связи «один к одному»', async () => {
    const result = await books({
      $filter: `details/id eq '${BOOK_DETAILS_IDS.compilerTheory}'`,
    });

    expect(result.map((book) => book.id)).toEqual([3]);
  });

  it('$expand с UUID-родителя на числовых детей', async () => {
    const result = await publishers({
      $expand: 'books($orderby=id asc)',
      $filter: `id eq '${PUBLISHER_IDS.clarendon}'`,
    });

    expect(result[0]?.books.map((book) => book.id)).toEqual([1, 2]);
  });

  it('сортировка по полю связи с ключом UUID', async () => {
    // Сортировка идёт по дате основания, а не по названию, и это не придирка к красоте:
    // 'MIT Press' и 'Manning Digital' встают в разном порядке в зависимости от collation
    // (побайтово 'I' < 'a', без учёта регистра — наоборот), и тест давал бы разный
    // результат на SQLite и MySQL. Дата от collation не зависит.
    const result = await books({ $orderby: 'publisher/foundedOn asc,id asc' });

    // Clarendon (1586) → книги 1, 2; MIT (1962) → 3, 4; Manning (1990) → 5.
    expect(result.map((book) => book.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it('обращение к сущности с UUID из середины цепочки', async () => {
    const result = await details({
      $expand: 'book($expand=publisher)',
      $filter: `id eq '${BOOK_DETAILS_IDS.compilerTheory}'`,
    });

    expect(result[0]?.book?.publisher.name).toBe('MIT Press');
  });
});
