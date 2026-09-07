/**
 * @file Модульные проверки `withAutoExpand`: это чистая работа со строкой `$expand`,
 * и база для неё не нужна. Поведение на реальной схеме закреплено отдельно —
 * `src/test/matrix/options.matrix.test.ts`, раздел «autoExpand».
 */
import type { EntityMetadata } from 'typeorm';

import { withAutoExpand } from './autoExpand';

/**
 * Метаданные-заглушка: функции нужен только перечень `propertyPath` связей.
 *
 * Настоящий `EntityMetadata` собирается лишь подключением к БД, поэтому здесь
 * минимальный объект нужной формы.
 */
function metadataOf(...relations: string[]): EntityMetadata {
  return { relations: relations.map((propertyPath) => ({ propertyPath })) } as EntityMetadata;
}

const book = metadataOf('author', 'publisher', 'category', 'reviews', 'tags', 'details');

describe('withAutoExpand', () => {
  it('без $expand перечисляет все связи корня', () => {
    expect(withAutoExpand(undefined, book)).toBe('author,publisher,category,reviews,tags,details');
  });

  it('пустая строка равнозначна отсутствию $expand', () => {
    expect(withAutoExpand('   ', book)).toBe('author,publisher,category,reviews,tags,details');
  });

  it('связь, названную клиентом, не дублирует', () => {
    expect(withAutoExpand('author', metadataOf('author', 'tags'))).toBe('author,tags');
  });

  it('не дублирует ни одну из перечисленных связей', () => {
    expect(withAutoExpand('author, tags', book)).toBe(
      'author, tags,publisher,category,reviews,details'
    );
  });

  it('сохраняет вложенные опции клиента', () => {
    expect(withAutoExpand('reviews($top=2;$orderby=id asc)', metadataOf('author', 'reviews'))).toBe(
      'reviews($top=2;$orderby=id asc),author'
    );
  });

  /**
   * Запятая внутри вложенных опций не разделяет сегменты `$expand`. Разбиение через
   * `split(',')` посчитало бы `'a'` отдельной связью и дописало бы `reviews` второй раз.
   */
  it('запятая внутри вложенного $filter не считается разделителем', () => {
    expect(
      withAutoExpand("reviews($filter=contains(text,'a'))", metadataOf('author', 'reviews'))
    ).toBe("reviews($filter=contains(text,'a')),author");
  });

  /** Тот же случай, но запятая и скобка спрятаны в строковом литерале. */
  it('запятая и скобка внутри литерала не считаются разделителями', () => {
    expect(withAutoExpand("reviews($filter=text eq 'a,b)')", metadataOf('author', 'reviews'))).toBe(
      "reviews($filter=text eq 'a,b)'),author"
    );
  });

  /** Удвоенная кавычка — экранированная кавычка внутри литерала, а не конец строки. */
  it('удвоенная кавычка внутри литерала не сбивает разбор', () => {
    expect(
      withAutoExpand("reviews($filter=text eq 'it''s,x')", metadataOf('reviews', 'tags'))
    ).toBe("reviews($filter=text eq 'it''s,x'),tags");
  });

  it('связь считается запрошенной по первому шагу пути', () => {
    expect(withAutoExpand('books/reviews', metadataOf('books', 'tags'))).toBe('books/reviews,tags');
  });

  it('добавляет только связи из белого списка и не отвергает запрос', () => {
    expect(withAutoExpand(undefined, book, ['author', 'details'])).toBe('author,details');
  });

  it('пустой белый список не добавляет ничего', () => {
    expect(withAutoExpand('author', book, [])).toBe('author');
  });

  it('исходное значение возвращается как есть, когда добавлять нечего', () => {
    expect(withAutoExpand('author', metadataOf('author'))).toBe('author');
    expect(withAutoExpand(undefined, metadataOf())).toBeUndefined();
  });

  /**
   * Связь внутри `@Embedded` адресуется путём с точкой (`meta.author`), а грамматика
   * `$expand` такого пути не знает: дописать её было бы нельзя, только сломать разбор.
   */
  it('связи внутри встроенных объектов пропускаются', () => {
    expect(withAutoExpand(undefined, metadataOf('meta.author', 'tags'))).toBe('tags');
  });
});
