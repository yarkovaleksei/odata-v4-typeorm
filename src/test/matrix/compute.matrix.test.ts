/**
 * @file Матрица совместимости: `$compute`.
 *
 * Опция не даёт ни новой грамматики выражений, ни нового SQL — она даёт имя уже умеющемуся
 * выражению. Поэтому проверяется не трансляция операторов (её покрывает `filter.matrix`),
 * а именно таблица имён: что имя находится в `$filter`, `$orderby` и `$select`, что оно
 * не подменяет собой свойство сущности, и что вычисленное значение доезжает до ответа
 * в тех же формах, в каких доезжают обычные колонки.
 *
 * Возраста авторов из `seed.sql`: Ada 36, Grace 45, Alan 41, Barbara 29.
 */
import { ODataInvalidQueryError, ODataParseError, ODataUnsupportedError } from '../../lib/errors';
import { executeQuery } from '../../lib/executeQuery';
import type { QueryParams } from '../../lib/types';
import { Author, Book, User } from '../fixtures';
import { dataSource } from '../setup/dataSource';
import { authorIds, expectRejected, rows, runMatrix, type MatrixCase } from './helpers';

/** Ответ с дописанными вычисленными свойствами: в типе сущности их, разумеется, нет. */
type Computed = Record<string, unknown>;

/** Авторы с вычисленными значениями. */
function authors(query: QueryParams, options = {}): Promise<Array<Author & Computed>> {
  return rows(dataSource.getRepository(Author), query, 'Author', options) as Promise<
    Array<Author & Computed>
  >;
}

describe('$compute в $filter', () => {
  const cases: readonly MatrixCase[] = [
    {
      name: 'арифметика под именем',
      query: { $compute: 'age mul 2 as doubled', $filter: 'doubled gt 80' },
      expected: [2, 3],
    },
    {
      name: 'имя употреблено дважды',
      // 37, 46, 42, 30 — в диапазон попадает только Alan.
      query: { $compute: 'age add 1 as next', $filter: 'next gt 37 and next lt 46' },
      expected: [3],
    },
    {
      name: 'строковая функция под именем',
      query: {
        $compute: "concat(name, '!') as loud",
        $filter: "loud eq 'Ada!'",
      },
      expected: [1],
    },
    {
      name: 'несколько имён сразу',
      query: {
        $compute: 'age mul 2 as doubled, age add 100 as shifted',
        $filter: 'doubled gt 80 and shifted lt 145',
      },
      expected: [3],
    },
    {
      name: 'имя внутри функции',
      query: {
        $compute: "concat(name, ' the great') as title",
        $filter: "contains(title, 'the great') and startswith(title, 'Ada')",
      },
      expected: [1],
    },
    {
      name: 'имя видно из тела лямбды',
      // Тело лямбды считает пути от книги, а имя без переменной — от внешней сущности:
      // порог 180, 225, 205, 145 против страниц 300/120, 450, 210 и книг у Barbara нет.
      query: {
        $compute: 'age mul 5 as threshold',
        $filter: 'books/any(b: b/pages gt threshold)',
      },
      expected: [1, 2, 3],
    },
    {
      name: 'выражение без единой колонки',
      query: { $compute: '2 mul 2 as four', $filter: 'four eq 4' },
      expected: [1, 2, 3, 4],
      skipOn: {
        // Тот же вырожденный случай, что и у арифметики над двумя литералами в `filter.matrix`:
        // `(:p0 * :p1)` — оба операнда безымянные плейсхолдеры, и перегрузку `*` PostgreSQL
        // выбрать не может. Свойство СУБД, а не трансляции; имя от этого ничего не меняет.
        postgres: 'PostgreSQL не выводит тип для выражения из двух плейсхолдеров',
      },
    },
  ];

  runMatrix(authorIds, cases);
});

describe('$compute в $orderby', () => {
  const cases: readonly MatrixCase[] = [
    {
      name: 'по вычисленному значению',
      query: { $compute: 'age mul -1 as inverted', $orderby: 'inverted asc' },
      expected: [2, 3, 1, 4],
      sorted: true,
    },
    {
      name: 'вместе с обычным полем',
      query: {
        $compute: 'rating mul 100 as score',
        $orderby: 'score desc, id asc',
      },
      expected: [2, 1, 4, 3],
      sorted: true,
    },
  ];

  runMatrix(authorIds, cases);
});

describe('$compute в $select', () => {
  it('вычисленное значение приходит в ответе рядом с колонками', async () => {
    const result = await authors({
      $compute: 'age mul 2 as doubled',
      $select: 'id,name,doubled',
      $orderby: 'id asc',
    });

    expect(result.map((author) => [author.name, Number(author['doubled'])])).toEqual([
      ['Ada', 72],
      ['Grace', 90],
      ['Alan', 82],
      ['Barbara', 58],
    ]);
  });

  it('$select только из псевдонимов возвращает одно вычисленное значение', async () => {
    // Первичный ключ библиотека добавляет в SELECT сама — по нему значение находит свою
    // сущность, — но в ответе его быть не должно: форму ответа задаёт один $select.
    const result = await authors({
      $compute: 'age add 1 as next',
      $select: 'next',
      $orderby: 'id asc',
    });

    expect(result.map((author) => Object.keys(author))).toEqual(
      Array.from({ length: 4 }, () => ['next'])
    );
    expect(result.map((author) => Number(author['next']))).toEqual([37, 46, 42, 30]);
  });

  it('ключ не появляется в ответе оттого, что его попросила библиотека', async () => {
    const result = await authors({
      $compute: 'age mul 2 as doubled',
      $select: 'name,doubled',
      $expand: 'books',
      $orderby: 'id asc',
      $top: '2',
    });

    expect(result.map((author) => author.name)).toEqual(['Ada', 'Grace']);
    expect(result.every((author) => !('id' in author))).toBe(true);
  });

  it('значение не размножается связями $expand', async () => {
    // У Ada две книги: в плоском результате две строки, а сущность одна — значение
    // обязано найти её по ключу, а не по номеру строки.
    const result = await authors({
      $compute: 'age mul 2 as doubled',
      $select: 'id,name,doubled',
      $expand: 'books',
      $orderby: 'id asc',
    });

    expect(result).toHaveLength(4);
    expect(result[0]!.books).toHaveLength(2);
    expect(result.map((author) => Number(author['doubled']))).toEqual([72, 90, 82, 58]);
  });

  it('работает вместе с пагинацией', async () => {
    const result = await authors({
      $compute: 'age mul 2 as doubled',
      $select: 'id,doubled',
      $expand: 'books',
      $orderby: 'id asc',
      $top: '2',
      $skip: '1',
    });

    expect(result.map((author) => [author.id, Number(author['doubled'])])).toEqual([
      [2, 90],
      [3, 82],
    ]);
  });

  it('$count считает строки, а не строки плоского результата', async () => {
    const result = await executeQuery(
      dataSource.getRepository(Author),
      {
        $compute: 'age mul 2 as doubled',
        $select: 'id,doubled',
        $expand: 'books',
        $count: 'true',
        $top: '2',
        $orderby: 'id asc',
      },
      { alias: 'Author' }
    );

    expect(Array.isArray(result)).toBe(false);

    const page = result as { items: Array<Author & Computed>; count: number };

    expect(page.count).toBe(4);
    expect(page.items.map((author) => Number(author['doubled']))).toEqual([72, 90]);
  });

  it('путь через связь «многие к одному» допустим', async () => {
    const result = (await rows(
      dataSource.getRepository(Book),
      {
        $compute: 'author/age mul 2 as authorAge',
        $select: 'id,title,authorAge',
        $orderby: 'id asc',
      },
      'Book'
    )) as Array<Book & Computed>;

    // Книга 5 без автора: LEFT JOIN даёт NULL, и это ровно трёхзначная логика SQL.
    // Number() здесь обязателен: тип вычисленного значения задаёт драйвер, а не библиотека,
    // и `age * 2` в MySQL приходит строкой (см. odata-support.md).
    expect(
      result.map((book) => (book['authorAge'] == null ? null : Number(book['authorAge'])))
    ).toEqual([72, 72, 90, 82, null]);
  });
});

describe('$compute — отказы', () => {
  it('имя, совпадающее со свойством сущности', async () => {
    // По спецификации это ошибка, а не переопределение: молча выигранное имя означало бы
    // фильтр не по той колонке.
    const error = await expectRejected(authorIds, {
      $compute: 'age mul 2 as name',
      $filter: "name eq 'Ada'",
    });

    expect(error).toBeInstanceOf(ODataInvalidQueryError);
  });

  it('повторяющееся имя', async () => {
    const error = await expectRejected(authorIds, {
      $compute: 'age as x, age add 1 as x',
      $filter: 'x gt 1',
    });

    expect(error).toBeInstanceOf(ODataInvalidQueryError);
  });

  it('выражение без имени', async () => {
    const error = await expectRejected(authorIds, { $compute: 'age mul 2' });

    expect(error).toBeInstanceOf(ODataParseError);
  });

  it('путь через связь «ко многим» в $select', async () => {
    // Значение считалось бы по каждой книге, и одного значения на автора у него нет.
    const error = await expectRejected(authorIds, {
      $compute: 'books/pages mul 2 as p',
      $select: 'id,p',
    });

    expect(error).toBeInstanceOf(ODataInvalidQueryError);
  });

  it('тот же путь в $filter допустим — это обычное условие по соединённой связи', async () => {
    await expect(
      authorIds({ $compute: 'books/pages mul 2 as p', $filter: 'p gt 800' })
    ).resolves.toEqual([2]);
  });

  /**
   * Вычисленные значения материализуются только для корня: они находят свою сущность
   * по первичному ключу корня, а для связи пришлось бы раскладывать их по элементам
   * каждой коллекции. Пока это не сделано, псевдоним во вложенном `$select` просто
   * не доехал бы до ответа — то есть запрос выполнился бы не так, как написан,
   * и без единого признака. Поэтому он отвергается.
   */
  it('псевдоним во вложенном $select внутри $expand', async () => {
    const error = await expectRejected(authorIds, {
      $expand: 'books($compute=pages mul 2 as doubled;$select=title,doubled)',
      $select: 'id',
    });

    expect(error).toBeInstanceOf(ODataUnsupportedError);
    expect(error.message).toContain('books($select=doubled)');
  });

  it('тот же псевдоним во вложенном $filter и $orderby работает', async () => {
    // Внутри связи область имён своя, и в её собственных $filter / $orderby псевдоним
    // разворачивается в выражение прямо в SQL — материализовать его для этого не нужно.
    const [ada] = await rows(
      dataSource.getRepository(Author),
      {
        $filter: 'id eq 1',
        $expand:
          'books($compute=pages mul 2 as doubled;$filter=doubled gt 400;$orderby=doubled desc)',
      },
      'Author'
    );

    expect(ada?.books.map((book) => book.id)).toEqual([1]);
  });

  it('поля внутри выражения проверяются по белому списку, а не имя псевдонима', async () => {
    // Иначе $compute стал бы обходом allowedFields: клиент назвал бы выражение как угодно.
    const query: QueryParams = { $compute: 'age mul 2 as doubled', $select: 'id,doubled' };

    await expect(authors(query, { allowedFields: ['id'] })).rejects.toBeInstanceOf(
      ODataInvalidQueryError
    );

    await expect(authors(query, { allowedFields: ['id', 'age'] })).resolves.toHaveLength(4);
  });

  it('невыбираемая колонка внутри выражения отвергается', async () => {
    // Фильтр по скрытой колонке работает как оракул для подбора значения — псевдоним
    // ничего в этом не меняет.
    await expect(
      rows(
        dataSource.getRepository(User),
        { $compute: 'concat(passwordHash, passwordHash) as h', $filter: "h ne ''" },
        'User'
      )
    ).rejects.toBeInstanceOf(ODataInvalidQueryError);
  });
});
