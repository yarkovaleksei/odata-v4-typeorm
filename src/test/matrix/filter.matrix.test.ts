/**
 * @file Матрица совместимости: `$filter`.
 *
 * Ожидания записаны по спецификации OData v4, а не по текущему поведению кода. Тест, который
 * падает, — это заявка на доработку, а не повод подогнать ожидание под реализацию.
 *
 * Фикстуры (`src/test/setup/dataSource.ts`):
 *
 *   id  name      age  rating  isActive  registeredAt         bio
 *   1   Ada       36   4.25    true      2020-01-15 10:30:00  'Pioneer of computing'
 *   2   Grace     45   4.9     true      2021-06-01 08:00:00  NULL
 *   3   Alan      41   3.2     false     NULL                 'Codebreaker'
 *   4   Barbara   29   4.25    true      2022-03-20 12:00:00  NULL
 */
import { ODataInvalidQueryError, ODataUnsupportedError } from '../../lib/errors';
import { executeQuery } from '../../lib/executeQuery';
import { Author } from '../fixtures';
import { dataSource } from '../setup/dataSource';
import { authorIds, bookIds, expectRejected, runMatrix, type MatrixCase } from './helpers';

describe('$filter — операторы сравнения', () => {
  const cases: readonly MatrixCase[] = [
    { name: 'eq по строке', query: { $filter: "name eq 'Ada'" }, expected: [1] },
    { name: 'eq по числу', query: { $filter: 'age eq 41' }, expected: [3] },
    { name: 'eq по дробному', query: { $filter: 'rating eq 4.25' }, expected: [1, 4] },
    { name: 'eq по булеву true', query: { $filter: 'isActive eq true' }, expected: [1, 2, 4] },
    { name: 'eq по булеву false', query: { $filter: 'isActive eq false' }, expected: [3] },
    { name: 'ne по строке', query: { $filter: "name ne 'Ada'" }, expected: [2, 3, 4] },
    { name: 'gt', query: { $filter: 'age gt 40' }, expected: [2, 3] },
    { name: 'ge', query: { $filter: 'age ge 41' }, expected: [2, 3] },
    { name: 'lt', query: { $filter: 'age lt 36' }, expected: [4] },
    { name: 'le', query: { $filter: 'age le 36' }, expected: [1, 4] },
  ];

  runMatrix(authorIds, cases);
});

describe('$filter — NULL', () => {
  const cases: readonly MatrixCase[] = [
    { name: 'eq null → IS NULL', query: { $filter: 'bio eq null' }, expected: [2, 4] },
    { name: 'ne null → IS NOT NULL', query: { $filter: 'bio ne null' }, expected: [1, 3] },
    {
      name: 'eq null по дате',
      query: { $filter: 'registeredAt eq null' },
      expected: [3],
    },
    {
      name: 'null слева от оператора',
      query: { $filter: 'null eq bio' },
      expected: [2, 4],
    },
  ];

  runMatrix(authorIds, cases);
});

describe('$filter — логические операторы', () => {
  const cases: readonly MatrixCase[] = [
    { name: 'and', query: { $filter: 'age gt 30 and isActive eq true' }, expected: [1, 2] },
    { name: 'or', query: { $filter: 'age lt 30 or age gt 44' }, expected: [2, 4] },
    {
      name: 'скобки меняют приоритет',
      query: { $filter: "(name eq 'Ada' or name eq 'Alan') and age gt 40" },
      expected: [3],
    },
    {
      name: 'три условия через and',
      query: { $filter: 'age gt 20 and age lt 50 and isActive eq true' },
      expected: [1, 2, 4],
    },
    // OData v4, раздел 5.1.1.9. Отрицание обязано инвертировать результат, а не исчезать.
    {
      name: 'not инвертирует условие',
      query: { $filter: "not (name eq 'Ada')" },
      expected: [2, 3, 4],
    },
    {
      name: 'not с составным условием',
      query: { $filter: 'not (age gt 40 or isActive eq false)' },
      expected: [1, 4],
    },
    /**
     * ПРИОРИТЕТ `not`. По спецификации OData v4 (раздел 5.1.1.9) он выше, чем у `and`,
     * поэтому `not (X) and Y` обязано читаться как `(not X) and Y`.
     *
     * Прежний парсер (`odata-v4-parser` 0.1.29) читал это как `not (X and Y)` — отрицание
     * захватывало всё выражение, и обойти это можно было только внешними скобками. Свой
     * парсер (R-18) приоритет соблюдает; обе записи теперь означают одно и то же,
     * и обе проверяются, чтобы расхождение не вернулось незаметно.
     */
    {
      name: 'not в сочетании с and',
      query: { $filter: "not (name eq 'Ada') and age gt 40" },
      expected: [2, 3],
    },
    {
      name: 'not в сочетании с and — с лишними внешними скобками',
      query: { $filter: "(not (name eq 'Ada')) and age gt 40" },
      expected: [2, 3],
    },
    {
      name: 'not не захватывает следующий or',
      // (not isActive) or age gt 44 → Alan (неактивен) и Grace (45).
      query: { $filter: 'not (isActive eq true) or age gt 44' },
      expected: [2, 3],
    },
    {
      name: 'not после and',
      query: { $filter: "age gt 40 and not (name eq 'Ada')" },
      expected: [2, 3],
    },
  ];

  runMatrix(authorIds, cases);
});

/**
 * Оператор `in` (OData v4, раздел 5.1.1.10).
 *
 * До версии 2.0.0 не разбирался вовсе: прежний парсер отвечал `Unexpected character`.
 */
describe('$filter — оператор in', () => {
  const cases: readonly MatrixCase[] = [
    { name: 'по числам', query: { $filter: 'age in (36, 45)' }, expected: [1, 2] },
    { name: 'по строкам', query: { $filter: "name in ('Ada', 'Alan')" }, expected: [1, 3] },
    { name: 'значение вне списка', query: { $filter: 'age in (99)' }, expected: [] },
    // Пустой список не совпадает ни с чем — а `IN ()` в SQL просто синтаксическая ошибка.
    { name: 'пустой список', query: { $filter: 'age in ()' }, expected: [] },
    {
      name: 'вместе с другим условием',
      query: { $filter: 'age in (36, 45, 41) and isActive eq true' },
      expected: [1, 2],
    },
    { name: 'под отрицанием', query: { $filter: 'not (age in (36, 45))' }, expected: [3, 4] },
  ];

  runMatrix(authorIds, cases);

  it('по полю связи', async () => {
    expect((await bookIds({ $filter: "author/name in ('Ada', 'Grace')" })).sort()).toEqual([
      1, 2, 3,
    ]);
  });
});

/**
 * Лямбда-операторы `any` и `all` (OData v4, раздел 5.1.1.13).
 *
 * До версии 2.0.0 не работали: прежний парсер молча отбрасывал тело лямбды, и до библиотеки
 * доходил обычный путь свойства — условие исчезало целиком. Оба разворачиваются
 * в коррелированный подзапрос `EXISTS`, поэтому число корневых строк не меняется.
 *
 * Данные: у Ada книги 1 (300 страниц) и 2 (120), у Grace — 3 (450), у Alan — 4 (210),
 * у Barbara книг нет.
 */
describe('$filter — лямбда-операторы', () => {
  const cases: readonly MatrixCase[] = [
    { name: 'any с условием', query: { $filter: 'books/any(b: b/pages gt 400)' }, expected: [2] },
    {
      name: 'any находит по любому элементу коллекции',
      query: { $filter: 'books/any(b: b/pages lt 200)' },
      expected: [1],
    },
    {
      name: 'any без условия — коллекция непуста',
      query: { $filter: 'books/any()' },
      expected: [1, 2, 3],
    },
    {
      name: 'all',
      query: { $filter: 'books/all(b: b/pages gt 200)' },
      // У Ada есть книга на 120 страниц — она выпадает; Barbara проходит: у неё книг нет,
      // а «все элементы пустой коллекции удовлетворяют условию» истинно.
      expected: [2, 3, 4],
    },
    {
      name: 'any не размножает корневые строки',
      // У Ada две подходящие книги, автор обязан вернуться один раз.
      query: { $filter: 'books/any(b: b/pages gt 100)' },
      expected: [1, 2, 3],
    },
    {
      name: 'any вместе с обычным условием',
      query: { $filter: "name eq 'Ada' and books/any(b: b/pages gt 200)" },
      expected: [1],
    },
    {
      name: 'отрицание лямбды',
      query: { $filter: 'not books/any(b: b/pages gt 400)' },
      expected: [1, 3, 4],
    },
    {
      name: 'путь до коллекции через две связи',
      query: { $filter: 'books/reviews/any(r: r/score eq 5)' },
      expected: [1, 2],
    },
    {
      name: 'вложенная лямбда',
      query: { $filter: 'books/any(b: b/reviews/any(r: r/score eq 5))' },
      expected: [1, 2],
    },
    {
      name: 'тело сравнивает поле связи с полем внешнего уровня',
      query: { $filter: 'books/any(b: b/pages gt age)' },
      expected: [1, 2, 3],
    },
  ];

  runMatrix(authorIds, cases);

  it('any по связи «многие ко многим»', async () => {
    expect((await bookIds({ $filter: "tags/any(t: t/label eq 'classic')" })).sort()).toEqual([
      1, 3,
    ]);
  });

  it('путь через связь внутри тела отвергается понятной ошибкой', async () => {
    const error = await expectRejected(authorIds, {
      $filter: "books/any(b: b/author/name eq 'Ada')",
    });

    expect(error).toBeInstanceOf(ODataUnsupportedError);
  });

  it('лямбда учитывается белым списком связей', async () => {
    // Иначе `allowedExpands` не закрывал бы доступ к связанной сущности через $filter.
    await expect(
      executeQuery(
        dataSource.getRepository(Author),
        { $filter: 'books/any(b: b/pages gt 100)' },
        { alias: 'Author', allowedExpands: ['reviews'] }
      )
    ).rejects.toBeInstanceOf(ODataInvalidQueryError);
  });

  it('поле внутри лямбды учитывается белым списком полей', async () => {
    await expect(
      executeQuery(
        dataSource.getRepository(Author),
        { $filter: 'books/any(b: b/pages gt 100)' },
        { alias: 'Author', allowedFields: ['name'], allowedExpands: ['books'] }
      )
    ).rejects.toBeInstanceOf(ODataInvalidQueryError);
  });
});

describe('$filter — арифметика', () => {
  // OData v4, раздел 5.1.1.7. Все пять операторов обязаны работать в любой части выражения.
  const cases: readonly MatrixCase[] = [
    { name: 'add', query: { $filter: 'age add 10 eq 46' }, expected: [1] },
    { name: 'sub', query: { $filter: 'age sub 10 eq 35' }, expected: [2] },
    { name: 'mul', query: { $filter: 'age mul 2 eq 82' }, expected: [3] },
    // OData v4, раздел 5.1.1.7: для целочисленных операндов `div` — целочисленное деление.
    // 36/2=18, 45/2=22, 41/2=20, 29/2=14 → строго больше 20 только у Grace.
    {
      name: 'div (целочисленное деление)',
      query: { $filter: 'age div 2 gt 20' },
      expected: [2],
      skipOn: {
        // В MySQL `/` всегда возвращает дробное (41/2 = 20.5), целочисленное деление —
        // отдельный оператор `DIV`. Подставлять `DIV` безусловно нельзя: на дробных
        // операндах он тоже усечёт результат, а типы операндов на этапе трансляции
        // неизвестны. См. `docs/odata-support.md`, раздел про `div`.
        mysql: 'в MySQL оператор / не выполняет целочисленное деление',
      },
    },
    { name: 'mod', query: { $filter: 'age mod 2 eq 1' }, expected: [2, 3, 4] },
    {
      name: 'арифметика справа от оператора',
      query: { $filter: 'age eq 20 add 16' },
      expected: [1],
      skipOn: {
        // `20 add 16` даёт `(:p0 + :p1)` — оба операнда безымянные плейсхолдеры,
        // и PostgreSQL не может выбрать перегрузку `+`: `operator is not unique:
        // unknown + unknown`. Свойство СУБД, а не дефект трансляции; случай вырожденный —
        // константное выражение клиент вычисляет сам.
        postgres: 'PostgreSQL не выводит тип для выражения из двух плейсхолдеров',
      },
    },
    {
      name: 'скобки в арифметике',
      query: { $filter: '(age add 4) mul 2 eq 80' },
      expected: [1],
    },
    { name: 'унарный минус', query: { $filter: 'age gt -1 and age lt 30' }, expected: [4] },
  ];

  runMatrix(authorIds, cases);
});

describe('$filter — строковые функции', () => {
  const cases: readonly MatrixCase[] = [
    { name: 'contains', query: { $filter: "contains(name,'ra')" }, expected: [2, 4] },
    { name: 'startswith', query: { $filter: "startswith(name,'A')" }, expected: [1, 3] },
    { name: 'endswith', query: { $filter: "endswith(name,'a')" }, expected: [1, 4] },
    { name: 'tolower', query: { $filter: "tolower(name) eq 'ada'" }, expected: [1] },
    { name: 'toupper', query: { $filter: "toupper(name) eq 'ADA'" }, expected: [1] },
    { name: 'length', query: { $filter: 'length(name) eq 3' }, expected: [1] },
    { name: 'indexof', query: { $filter: "indexof(name,'da') eq 1" }, expected: [1] },
    { name: 'trim', query: { $filter: "trim(name) eq 'Ada'" }, expected: [1] },
    {
      name: 'substring с двумя аргументами',
      query: { $filter: "substring(name,1) eq 'da'" },
      expected: [1],
    },
    {
      name: 'substring с тремя аргументами',
      query: { $filter: "substring(name,0,3) eq 'Ada'" },
      expected: [1],
    },
    { name: 'concat', query: { $filter: "concat(name,'!') eq 'Ada!'" }, expected: [1] },
    { name: 'replace', query: { $filter: "replace(name,'a','A') eq 'AdA'" }, expected: [1] },
    {
      // Замена по тексту, а не по одному символу: проверяет и порядок аргументов,
      // и то, что заменяются все вхождения, а не первое.
      name: 'replace по нескольким вхождениям',
      query: { $filter: "replace(bio,' ','_') eq 'Pioneer_of_computing'" },
      expected: [1],
    },

    // Ключевой сценарий дефекта A-01: LIKE-функция после обычного сравнения.
    {
      name: 'contains после eq в одном фильтре',
      query: { $filter: "age eq 45 and contains(name,'race')" },
      expected: [2],
    },
    {
      name: 'contains до и после eq',
      query: { $filter: "contains(name,'A') and age eq 41 and endswith(name,'n')" },
      expected: [3],
    },
    {
      name: 'две LIKE-функции подряд',
      query: { $filter: "startswith(name,'A') and endswith(name,'a')" },
      expected: [1],
    },
  ];

  runMatrix(authorIds, cases);
});

describe('$filter — числовые функции', () => {
  const cases: readonly MatrixCase[] = [
    // Значения в фикстурах подобраны без «половинок»: округление ровно 4.5 у СУБД разное —
    // SQLite округляет от нуля (5), PostgreSQL для float8 применяет банковское (4).
    // Это свойство самих баз, проверять на нём трансляцию OData бессмысленно.
    { name: 'round вверх', query: { $filter: 'round(rating) eq 5' }, expected: [2] },
    { name: 'round вниз', query: { $filter: 'round(rating) eq 3' }, expected: [3] },
    { name: 'floor', query: { $filter: 'floor(rating) eq 4' }, expected: [1, 2, 4] },
    { name: 'ceiling', query: { $filter: 'ceiling(rating) eq 4' }, expected: [3] },
  ];

  runMatrix(authorIds, cases);
});

describe('$filter — функции даты и времени', () => {
  const cases: readonly MatrixCase[] = [
    { name: 'year', query: { $filter: 'year(registeredAt) eq 2021' }, expected: [2] },
    { name: 'month', query: { $filter: 'month(registeredAt) eq 3' }, expected: [4] },
    { name: 'day', query: { $filter: 'day(registeredAt) eq 15' }, expected: [1] },
    { name: 'hour', query: { $filter: 'hour(registeredAt) eq 8' }, expected: [2] },
    { name: 'minute', query: { $filter: 'minute(registeredAt) eq 30' }, expected: [1] },
    { name: 'second', query: { $filter: 'second(registeredAt) eq 0' }, expected: [1, 2, 4] },
    {
      name: 'сравнение с литералом даты-времени',
      query: { $filter: 'registeredAt lt 2021-01-01T00:00:00Z' },
      expected: [1],
    },
    {
      name: 'date выделяет календарную дату',
      query: { $filter: 'date(registeredAt) eq 2020-01-15' },
      expected: [1],
    },
    {
      name: 'time выделяет время суток',
      query: { $filter: 'time(registeredAt) eq 08:00:00' },
      expected: [2],
    },
    {
      // У всех фикстур дробная часть нулевая — колонка объявлена без неё. Проверяется
      // поэтому не значение, а что выражение вообще исполняется во всех трёх СУБД:
      // формы записи (EXTRACT, MICROSECOND, strftime) не пересекаются.
      // Автор 3 не попадает в выдачу: registeredAt у него NULL.
      name: 'fractionalseconds',
      query: { $filter: 'fractionalseconds(registeredAt) eq 0' },
      expected: [1, 2, 4],
    },
    {
      // Литерал длительности сворачивается в число при компиляции, поэтому случай работает
      // и в СУБД без типа интервала. Порог в 40 секунд отделяет секунды от миллисекунд:
      // при ошибке в единицах измерения вернулись бы все четыре автора.
      name: 'totalseconds над литералом',
      query: { $filter: "age lt totalseconds(duration'PT40S')" },
      expected: [1, 4],
    },
    {
      // Знак длительности раньше терялся при разборе литерала: без него порог стал бы
      // положительным, и выдача осталась бы прежней — поэтому сравнение выбрано так,
      // чтобы отличать -3600 от 3600.
      name: 'totalseconds над отрицательной длительностью',
      query: { $filter: "age gt totalseconds(duration'-PT1H')" },
      expected: [1, 2, 3, 4],
    },
  ];

  runMatrix(authorIds, cases);
});

describe('$filter — пути по связям', () => {
  const cases: readonly MatrixCase[] = [
    {
      name: 'фильтр по полю связи many-to-one',
      query: { $filter: "author/name eq 'Ada'" },
      expected: [1, 2],
    },
    {
      name: 'фильтр по полю связи с числом',
      query: { $filter: 'author/age gt 40' },
      expected: [3, 4],
    },
  ];

  runMatrix(bookIds, cases);
});
