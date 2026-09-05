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
import { authorIds, bookIds, runMatrix, type MatrixCase } from './helpers';

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
    { name: 'not инвертирует условие', query: { $filter: "not (name eq 'Ada')" }, expected: [2, 3, 4] },
    {
      name: 'not с составным условием',
      query: { $filter: 'not (age gt 40 or isActive eq false)' },
      expected: [1, 4],
    },
    /**
     * ОГРАНИЧЕНИЕ ПАРСЕРА. По спецификации OData v4 (раздел 5.1.1.9) приоритет `not` выше,
     * чем у `and`, поэтому `not (X) and Y` обязано читаться как `(not X) and Y`.
     * `odata-v4-parser` 0.1.29 разбирает это как `not (X and Y)` — то есть отрицание
     * захватывает всё выражение целиком.
     *
     * Здесь зафиксирован рабочий обходной путь: явные внешние скобки вокруг `not`.
     * Починка приоритета требует форка парсера — см. `docs/roadmap.md`, задача R-18.
     */
    {
      name: 'not в сочетании с and (со скобками — обход ограничения парсера)',
      query: { $filter: "(not (name eq 'Ada')) and age gt 40" },
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
    { name: 'substring с двумя аргументами', query: { $filter: "substring(name,1) eq 'da'" }, expected: [1] },
    {
      name: 'substring с тремя аргументами',
      query: { $filter: "substring(name,0,3) eq 'Ada'" },
      expected: [1],
    },
    { name: 'concat', query: { $filter: "concat(name,'!') eq 'Ada!'" }, expected: [1] },

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
    { name: 'date выделяет календарную дату', query: { $filter: 'date(registeredAt) eq 2020-01-15' }, expected: [1] },
    { name: 'time выделяет время суток', query: { $filter: 'time(registeredAt) eq 08:00:00' }, expected: [2] },
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
