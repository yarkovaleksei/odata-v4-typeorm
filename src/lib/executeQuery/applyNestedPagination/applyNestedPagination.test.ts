/**
 * @file Срез страницы связанных записей в памяти.
 *
 * Это запасной путь: там, где перенос пагинации в SQL разрешён, страницу вырезает оконная
 * функция, и сюда попадает уже готовое дерево. На MySQL — и на любой связи, для которой
 * условие построить не удалось, — режет этот модуль. Оба пути обязаны давать один результат,
 * поэтому проверяется он же, что и в матрице, но без базы.
 */
import { TypeOrmVisitor } from '../../TypeOrmVisitor';
import { applyNestedPagination } from './applyNestedPagination';

/** Include-посетитель: для среза значимы только имя связи, `limit` и `skip`. */
function include(navigationProperty: string, limit?: number, skip?: number): TypeOrmVisitor {
  const visitor = new TypeOrmVisitor({ alias: navigationProperty, useParameters: true });

  visitor.navigationProperty = navigationProperty;
  visitor.limit = limit;
  visitor.skip = skip;

  return visitor;
}

/** Автор с книгами, пронумерованными от единицы. */
const author = (count: number) => ({
  id: 1,
  books: Array.from({ length: count }, (_, index) => ({ id: index + 1 })),
});

describe('applyNestedPagination', () => {
  it('$top оставляет первые записи связи', () => {
    const entities = [author(5)];

    applyNestedPagination(entities, [include('books', 2)]);

    expect(entities[0]!.books.map((book) => book.id)).toEqual([1, 2]);
  });

  it('$skip вместе с $top даёт запрошенную страницу', () => {
    const entities = [author(5)];

    applyNestedPagination(entities, [include('books', 2, 1)]);

    expect(entities[0]!.books.map((book) => book.id)).toEqual([2, 3]);
  });

  it('$skip без $top отрезает начало и оставляет хвост', () => {
    const entities = [author(4)];

    applyNestedPagination(entities, [include('books', undefined, 2)]);

    expect(entities[0]!.books.map((book) => book.id)).toEqual([3, 4]);
  });

  /**
   * По OData v4 (раздел 11.2.6.4) `$top=0` — корректный запрос пустой страницы, а не
   * «ограничения нет». Трактовать ноль как отсутствие опции значило бы вернуть всё.
   */
  it('$top=0 даёт пустую связь', () => {
    const entities = [author(3)];

    applyNestedPagination(entities, [include('books', 0)]);

    expect(entities[0]!.books).toEqual([]);
  });

  it('связь без ограничений остаётся целиком', () => {
    const entities = [author(3)];

    applyNestedPagination(entities, [include('books')]);

    expect(entities[0]!.books).toHaveLength(3);
  });

  it('связь, страницу которой уже вырезал SQL, не режется повторно', () => {
    // Второй срез над уже вырезанной страницей отдал бы первые записи страницы вместо неё
    // самой: `$skip=2` применился бы к трём оставшимся строкам, а не к исходным пяти.
    const entities = [author(3)];
    const books = include('books', 2, 1);

    applyNestedPagination(entities, [books], new Set([books]));

    expect(entities[0]!.books).toHaveLength(3);
  });

  it('ограничение на связи второго уровня применяется через одиночную связь', () => {
    // В `ManyToOne` спускаться нужно, хотя резать там нечего: `$top` может стоять глубже.
    const details = include('reviews', 1);
    const book = include('book');

    book.includes = [details];

    const entities = [{ id: 1, book: { id: 10, reviews: [{ id: 1 }, { id: 2 }] } }];

    applyNestedPagination(entities, [book]);

    expect(entities[0]!.book.reviews).toHaveLength(1);
  });

  it('пустая связь «многие к одному» не мешает обходу', () => {
    // Гидрация TypeORM оставляет null у связи без записи, и обход не должен на нём падать.
    const entities = [
      { id: 1, book: null },
      { id: 2, book: { id: 10, reviews: [{ id: 1 }] } },
    ];

    expect(() => applyNestedPagination(entities, [include('book')])).not.toThrow();
  });

  it('null среди связанных записей не прерывает обход вглубь', () => {
    const reviews = include('reviews', 1);
    const books = include('books');

    books.includes = [reviews];

    const entities = [{ id: 1, books: [null, { id: 10, reviews: [{ id: 1 }, { id: 2 }] }] }];

    applyNestedPagination(entities, [books]);

    expect(entities[0]!.books[1]!.reviews).toHaveLength(1);
  });

  it('возвращает те же сущности для сцепления вызовов', () => {
    const entities = [author(2)];

    expect(applyNestedPagination(entities, [])).toBe(entities);
  });
});
