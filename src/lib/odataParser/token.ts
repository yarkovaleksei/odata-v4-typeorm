/**
 * @file Узлы синтаксического дерева OData.
 *
 * Имена типов совпадают с теми, что отдавал `odata-v4-parser`: по ним посетитель выбирает
 * метод обхода (`Visit${node.type}`), и менять их значило бы переписывать посетитель заодно
 * с парсером. Сам набор при этом сокращён до того, что библиотека действительно транслирует —
 * узлов ресурсных путей, JSON-литералов и `$apply` здесь нет, потому что нет и трансляции.
 *
 * ФОРМА УЗЛА повторяет прежнюю: `type` выбирает обработчик, `raw` — исходный текст фрагмента
 * (посетитель опирается на него для путей связей), `value` — содержимое, своё для каждого типа.
 * `position` и `next` — границы фрагмента в исходной строке; нужны для сообщений об ошибках.
 */

/**
 * Тип узла дерева.
 *
 * Значения — строки, а не числа: они попадают в имя метода посетителя, а при отладке
 * читаемый `type` в дампе дерева стоит дороже пары байт.
 */
export enum TokenType {
  // ── Уровень query options ────────────────────────────────────────────────
  QueryOptions = 'QueryOptions',
  Filter = 'Filter',
  Select = 'Select',
  SelectItem = 'SelectItem',
  OrderBy = 'OrderBy',
  OrderByItem = 'OrderByItem',
  Skip = 'Skip',
  Top = 'Top',
  InlineCount = 'InlineCount',
  Search = 'Search',
  Expand = 'Expand',
  ExpandItem = 'ExpandItem',
  ExpandPath = 'ExpandPath',

  // ── Логика ───────────────────────────────────────────────────────────────
  AndExpression = 'AndExpression',
  OrExpression = 'OrExpression',
  NotExpression = 'NotExpression',
  BoolParenExpression = 'BoolParenExpression',

  // ── Сравнения ────────────────────────────────────────────────────────────
  EqualsExpression = 'EqualsExpression',
  NotEqualsExpression = 'NotEqualsExpression',
  LesserThanExpression = 'LesserThanExpression',
  LesserOrEqualsExpression = 'LesserOrEqualsExpression',
  GreaterThanExpression = 'GreaterThanExpression',
  GreaterOrEqualsExpression = 'GreaterOrEqualsExpression',
  InExpression = 'InExpression',

  // ── Арифметика ───────────────────────────────────────────────────────────
  AddExpression = 'AddExpression',
  SubExpression = 'SubExpression',
  MulExpression = 'MulExpression',
  DivExpression = 'DivExpression',
  ModExpression = 'ModExpression',
  NegateExpression = 'NegateExpression',
  ParenExpression = 'ParenExpression',

  // ── Операнды ─────────────────────────────────────────────────────────────
  PropertyPathExpression = 'PropertyPathExpression',
  ODataIdentifier = 'ODataIdentifier',
  Literal = 'Literal',
  MethodCallExpression = 'MethodCallExpression',
  LambdaExpression = 'LambdaExpression',
  /**
   * Имя типа в позиции аргумента: `cast(age, Edm.String)`.
   *
   * Отдельный тип узла, а не литерал: значение здесь не данные, а имя типа, и превращать
   * его в параметр запроса нельзя. Осмыслен он ровно в одном месте — втором аргументе
   * `cast`; в любом другом посетитель его отвергает.
   */
  TypeReference = 'TypeReference',
}

/**
 * Узел дерева.
 *
 * `value` объявлен как `unknown`, а не размеченным объединением по `type`: посетитель
 * читает его через `node.value.left` и подобные обращения, и объединение заставило бы
 * его сужать тип на каждом шаге ради выигрыша, которого там нет — обработчик и так вызван
 * по своему `type`.
 */
export interface Token {
  /** Смещение начала фрагмента в исходной строке. */
  position: number;
  /** Смещение конца фрагмента (не включительно). */
  next: number;
  /** Содержимое узла; форма зависит от `type`. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value: any;
  type: TokenType;
  /** Исходный текст фрагмента — ровно как он записан в запросе. */
  raw: string;
}

/** Собирает узел, вычисляя `raw` по границам фрагмента. */
export function createToken(
  source: string,
  position: number,
  next: number,
  type: TokenType,
  value: unknown
): Token {
  return { position, next, type, value, raw: source.slice(position, next) };
}
