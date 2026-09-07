/**
 * @file Разбор выражений OData: `$filter`, элементы `$orderby`, аргументы функций.
 *
 * Рекурсивный спуск по грамматике из спецификации OData v4 (раздел 5.1.1), сведённой
 * к поддерживаемому подмножеству. Порядок функций снизу вверх повторяет приоритет операторов:
 *
 * ```
 * expression     := or
 * or             := and ('or' and)*
 * and            := not ('and' not)*
 * not            := 'not' not | comparison
 * comparison     := additive (('eq'|'ne'|'gt'|'ge'|'lt'|'le') additive | 'in' '(' список ')')?
 * additive       := multiplicative (('add'|'sub') multiplicative)*
 * multiplicative := unary (('mul'|'div'|'mod') unary)*
 * unary          := '-' unary | primary
 * primary        := '(' expression ')' | литерал | вызов функции | путь свойства | лямбда
 * лямбда         := путь '/' ('any'|'all') '(' [переменная ':' expression] ')'
 * ```
 *
 * ПРИОРИТЕТ `not` — единственное место, где грамматика спецификации сама себе противоречит.
 * Таблица приоритетов (раздел 5.1.1) ставит унарные операторы выше сравнений, а ABNF там же
 * определяет `notExpr = 'not' RWS boolCommonExpr`, то есть `not` поглощает и `and`, и `or`.
 * Прежний парсер следовал ABNF, из-за чего `not (X) and Y` читалось как `not (X and Y)` —
 * отрицание захватывало всё выражение, и это было записано в документации как известное
 * расхождение. Здесь `not` применяется к сравнению: `not (X) and Y` даёт `(not X) and Y`,
 * а `not a eq b` — `not (a eq b)`. Первое чинит расхождение, второе — единственное осмысленное
 * прочтение: `not` над нелогическим операндом не имеет смысла ни в одной СУБД.
 *
 * ЛЯМБДЫ `any` / `all` разбираются вместе с телом. Прежний парсер тело молча отбрасывал,
 * и до библиотеки доходил обычный путь свойства — то есть условие исчезало, а запрос
 * возвращал больше строк, чем просили.
 *
 * ЧЕГО ЗДЕСЬ НЕТ. `has`, `cast`, `isof`, геопространственные функции и `$apply` не разбираются:
 * для них нет трансляции в SQL. Вызов несуществующей функции при этом разбирается как обычный
 * вызов и отвергается уже посетителем — так сообщение об ошибке называет саму функцию,
 * а не позицию символа.
 */
import { Scanner } from './scanner';
import { createToken, TokenType, type Token } from './token';

/** Соответствие оператора сравнения OData типу узла. */
const COMPARISON_OPERATORS: ReadonlyArray<readonly [string, TokenType]> = [
  ['eq', TokenType.EqualsExpression],
  ['ne', TokenType.NotEqualsExpression],
  ['gt', TokenType.GreaterThanExpression],
  ['ge', TokenType.GreaterOrEqualsExpression],
  ['lt', TokenType.LesserThanExpression],
  ['le', TokenType.LesserOrEqualsExpression],
];

/** Соответствие арифметического оператора типу узла. */
const ADDITIVE_OPERATORS: ReadonlyArray<readonly [string, TokenType]> = [
  ['add', TokenType.AddExpression],
  ['sub', TokenType.SubExpression],
];

const MULTIPLICATIVE_OPERATORS: ReadonlyArray<readonly [string, TokenType]> = [
  ['mul', TokenType.MulExpression],
  ['div', TokenType.DivExpression],
  ['mod', TokenType.ModExpression],
];

/**
 * Шаблоны литералов, привязанные к текущей позиции (флаг `y`).
 *
 * Порядок проверки важен и задаётся не здесь, а в {@link ExpressionParser.tryLiteral}:
 * `2020-01-15T10:30:00Z` начинается так же, как `2020-01-15`, а `08:00:00` — так же,
 * как число `08`.
 */
const PATTERNS = {
  guid: /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/y,
  dateTimeOffset: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})/y,
  date: /\d{4}-\d{2}-\d{2}/y,
  timeOfDay: /\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?/y,
  number: /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y,
} as const;

/** Узлы, которые являются логическими: от этого зависит вид скобочной группы. */
const BOOLEAN_NODES: ReadonlySet<TokenType> = new Set([
  TokenType.AndExpression,
  TokenType.OrExpression,
  TokenType.NotExpression,
  TokenType.BoolParenExpression,
  TokenType.EqualsExpression,
  TokenType.NotEqualsExpression,
  TokenType.LesserThanExpression,
  TokenType.LesserOrEqualsExpression,
  TokenType.GreaterThanExpression,
  TokenType.GreaterOrEqualsExpression,
]);

/**
 * Разбор выражения. Состояние — только позиция курсора, поэтому один экземпляр
 * обслуживает и `$filter`, и вложенные выражения внутри `$expand`.
 */
export class ExpressionParser {
  constructor(public readonly scanner: Scanner) {}

  /** Разбирает выражение целиком, начиная с текущей позиции. */
  public parse(): Token {
    return this.or();
  }

  private or(): Token {
    let left = this.and();

    while (this.scanner.tryTakeKeyword('or')) {
      left = this.binary(TokenType.OrExpression, left, this.and());
    }

    return left;
  }

  private and(): Token {
    let left = this.not();

    while (this.scanner.tryTakeKeyword('and')) {
      left = this.binary(TokenType.AndExpression, left, this.not());
    }

    return left;
  }

  private not(): Token {
    const start = this.scanner.position;

    if (this.scanner.tryTakeKeyword('not')) {
      const operand = this.not();

      return createToken(
        this.scanner.source,
        start,
        operand.next,
        TokenType.NotExpression,
        operand
      );
    }

    return this.comparison();
  }

  private comparison(): Token {
    const left = this.additive();

    if (this.scanner.tryTakeKeyword('in')) {
      return this.inList(left);
    }

    const type = this.tryTakeOperator(COMPARISON_OPERATORS);

    // Сравнение не цепочечное: `a lt b lt c` в OData не выражение, а ошибка.
    return type ? this.binary(type, left, this.additive()) : left;
  }

  /**
   * Правая часть оператора `in`: список значений в скобках.
   *
   * По спецификации (раздел 5.1.1.10) справа может стоять и путь к коллекции
   * (`Name in Emails`), но такой формы у библиотеки нет: значения коллекции лежат
   * в другой таблице, и это уже лямбда-оператор.
   */
  private inList(left: Token): Token {
    this.scanner.take('(', 'a parenthesised list of values');

    const values: Token[] = [];

    if (!this.scanner.peek(')')) {
      do {
        values.push(this.parse());
      } while (this.scanner.tryTake(','));
    }

    this.scanner.take(')');

    return createToken(
      this.scanner.source,
      left.position,
      this.scanner.position,
      TokenType.InExpression,
      { left, values }
    );
  }

  private additive(): Token {
    let left = this.multiplicative();

    for (;;) {
      const type = this.tryTakeOperator(ADDITIVE_OPERATORS);

      if (!type) {
        return left;
      }

      left = this.binary(type, left, this.multiplicative());
    }
  }

  private multiplicative(): Token {
    let left = this.unary();

    for (;;) {
      const type = this.tryTakeOperator(MULTIPLICATIVE_OPERATORS);

      if (!type) {
        return left;
      }

      left = this.binary(type, left, this.unary());
    }
  }

  /** Съедает первый подошедший оператор из таблицы и возвращает тип его узла. */
  private tryTakeOperator(
    table: ReadonlyArray<readonly [string, TokenType]>
  ): TokenType | undefined {
    for (const [keyword, type] of table) {
      if (this.scanner.tryTakeKeyword(keyword)) {
        return type;
      }
    }

    return undefined;
  }

  private unary(): Token {
    this.scanner.skipWhitespace();

    const start = this.scanner.position;

    if (this.scanner.tryTake('-')) {
      // Минус вплотную к цифре — знак числа, а не оператор: так `-7` остаётся одним
      // литералом и попадает в параметры целиком, а не как `-(7)`.
      if (/\d/.test(this.scanner.current)) {
        this.scanner.position = start;

        return this.primary();
      }

      const operand = this.unary();

      return createToken(
        this.scanner.source,
        start,
        operand.next,
        TokenType.NegateExpression,
        operand
      );
    }

    return this.primary();
  }

  private primary(): Token {
    this.scanner.skipWhitespace();

    const start = this.scanner.position;

    if (this.scanner.tryTake('(')) {
      const inner = this.parse();

      this.scanner.take(')');

      const type = BOOLEAN_NODES.has(inner.type)
        ? TokenType.BoolParenExpression
        : TokenType.ParenExpression;

      return createToken(this.scanner.source, start, this.scanner.position, type, inner);
    }

    const literal = this.tryLiteral();

    if (literal) {
      return literal;
    }

    return this.memberOrCall();
  }

  /**
   * Литерал: `null`, логическое значение, строка, GUID, дата, время, число.
   *
   * @returns узел литерала либо `undefined`, если в текущей позиции литерала нет.
   */
  private tryLiteral(): Token | undefined {
    this.scanner.skipWhitespace();

    const start = this.scanner.position;

    if (this.scanner.tryTakeKeyword('null')) {
      return this.literal(start, 'null');
    }

    if (this.scanner.tryTakeKeyword('true') || this.scanner.tryTakeKeyword('false')) {
      return this.literal(start, 'Edm.Boolean');
    }

    // Бесконечности и «не число» записываются словами и потому проверяются до путей свойств.
    if (
      this.scanner.tryTakeKeyword('INF') ||
      this.scanner.tryTakeKeyword('-INF') ||
      this.scanner.tryTakeKeyword('NaN')
    ) {
      return this.literal(start, 'Edm.Double');
    }

    if (this.scanner.at("'")) {
      this.scanner.takeStringLiteral();

      return this.literal(start, 'Edm.String');
    }

    // `duration'P1D'` — префикс с типом перед строкой.
    if (this.scanner.peekKeyword('duration')) {
      const saved = this.scanner.position;

      this.scanner.tryTakeKeyword('duration');

      if (this.scanner.at("'")) {
        this.scanner.takeStringLiteral();

        return this.literal(start, 'Edm.Duration');
      }

      this.scanner.position = saved;
    }

    const matched =
      this.tryPattern('guid', 'Edm.Guid') ??
      this.tryPattern('dateTimeOffset', 'Edm.DateTimeOffset') ??
      this.tryPattern('date', 'Edm.Date') ??
      this.tryPattern('timeOfDay', 'Edm.TimeOfDay') ??
      this.tryNumber();

    return matched;
  }

  /** Сопоставляет шаблон литерала с текущей позицией. */
  private tryPattern(pattern: keyof typeof PATTERNS, edmType: string): Token | undefined {
    const regexp = PATTERNS[pattern];
    const start = this.scanner.position;

    regexp.lastIndex = start;

    const match = regexp.exec(this.scanner.source);

    if (!match) {
      return undefined;
    }

    this.scanner.position = start + match[0].length;

    return this.literal(start, edmType);
  }

  /**
   * Число: целое даёт `Edm.Int64`, дробное и запись с порядком — `Edm.Decimal`.
   *
   * Обе ветки `Literal.convert` приводит к числу JavaScript, поэтому различие видно только
   * в дереве; сохранено оно ради читаемости дампа при отладке.
   */
  private tryNumber(): Token | undefined {
    const start = this.scanner.position;

    PATTERNS.number.lastIndex = start;

    const match = PATTERNS.number.exec(this.scanner.source);

    if (!match) {
      return undefined;
    }

    this.scanner.position = start + match[0].length;

    const fractional = match[0].includes('.') || /[eE]/.test(match[0]);

    return this.literal(start, fractional ? 'Edm.Decimal' : 'Edm.Int64');
  }

  /** Собирает узел литерала: значением служит имя типа EDM, как и в прежнем парсере. */
  private literal(start: number, edmType: string): Token {
    return createToken(
      this.scanner.source,
      start,
      this.scanner.position,
      TokenType.Literal,
      edmType
    );
  }

  /**
   * Вызов функции либо путь свойства — различаются по скобке после имени.
   *
   * Имя функции может быть составным (`geo.distance`): такие функции библиотека не умеет,
   * но разобрать их нужно, чтобы отказ пришёл от посетителя и назвал функцию по имени.
   */
  private memberOrCall(): Token {
    this.scanner.skipWhitespace();

    const start = this.scanner.position;
    const first = this.scanner.takeIdentifier('a property path or a function call');

    // Составное имя функции: `geo.distance(...)`.
    let name = first;

    while (this.scanner.at('.')) {
      this.scanner.position += 1;
      name += `.${this.scanner.takeIdentifier('a function name')}`;
    }

    if (this.scanner.at('(')) {
      return this.methodCall(start, name);
    }

    if (name !== first) {
      this.scanner.fail('qualified names are only allowed for function calls');
    }

    return this.propertyPath(start, first);
  }

  /** Аргументы функции: выражения через запятую. */
  private methodCall(start: number, method: string): Token {
    this.scanner.take('(');

    const parameters: Token[] = [];

    if (!this.scanner.peek(')')) {
      do {
        parameters.push(this.parse());
      } while (this.scanner.tryTake(','));
    }

    this.scanner.take(')');

    return createToken(
      this.scanner.source,
      start,
      this.scanner.position,
      TokenType.MethodCallExpression,
      { method, parameters }
    );
  }

  /**
   * Путь свойства: `name`, `author/name`, `books/reviews/score`.
   *
   * Посетитель читает путь целиком из `raw`, а `current` / `next` использует только как
   * признак «путь составной». Поэтому вложенность здесь ровно одноуровневая: первый сегмент
   * и всё остальное — раскладывать её глубже было бы работой ради формы дерева.
   */
  private propertyPath(start: number, first: string): Token {
    const segments: Array<{ name: string; position: number }> = [{ name: first, position: start }];
    let end = this.scanner.position;

    while (this.scanner.at('/')) {
      const saved = this.scanner.position;

      this.scanner.position += 1;

      const position = this.scanner.position;
      const segment = this.scanner.tryTakeIdentifier();

      if (segment === undefined) {
        this.scanner.position = saved;
        break;
      }

      // Лямбда-операторы: `posts/any(p: p/title eq 'x')`.
      if ((segment === 'any' || segment === 'all') && this.scanner.at('(')) {
        return this.lambda(start, segments, segment);
      }

      segments.push({ name: segment, position });
      end = this.scanner.position;
    }

    return this.pathNode(segments, 0, end);
  }

  /**
   * Собирает узел пути из сегментов, начиная с указанного.
   *
   * Составной путь разворачивается в цепочку `current` / `next`: посетитель читает путь
   * целиком из `raw`, а по наличию `current` отличает составной путь от простого имени.
   */
  private pathNode(
    segments: ReadonlyArray<{ name: string; position: number }>,
    index: number,
    end: number
  ): Token {
    const segment = segments[index] as { name: string; position: number };
    const identifier: Token = {
      position: segment.position,
      next: segment.position + segment.name.length,
      type: TokenType.ODataIdentifier,
      value: { name: segment.name },
      raw: segment.name,
    };

    const value =
      index === segments.length - 1
        ? identifier
        : { current: identifier, next: this.pathNode(segments, index + 1, end) };

    return createToken(
      this.scanner.source,
      segment.position,
      end,
      TokenType.PropertyPathExpression,
      value
    );
  }

  /**
   * Лямбда-оператор: `books/any(b: b/pages gt 100)`, `books/all(b: …)`, `books/any()`.
   *
   * Тело разбирается как обычное выражение — переменная в нём выглядит как первый сегмент
   * пути (`b/pages`). Связать её с таблицей может только тот, у кого есть метаданные,
   * поэтому здесь она просто запоминается по имени.
   */
  private lambda(
    start: number,
    navigation: ReadonlyArray<{ name: string; position: number }>,
    operator: 'any' | 'all'
  ): Token {
    this.scanner.take('(');

    let variable = '';
    let predicate: Token | undefined;

    if (!this.scanner.peek(')')) {
      variable = this.scanner.takeIdentifier('a lambda variable');

      this.scanner.take(':', '":" after the lambda variable');

      predicate = this.parse();
    }

    this.scanner.take(')');

    if (operator === 'all' && !predicate) {
      // `all()` без условия истинно для чего угодно и потому бессмысленно; спецификация
      // пустое тело разрешает только для `any` («коллекция непуста»).
      this.scanner.fail('all() requires a predicate');
    }

    return createToken(
      this.scanner.source,
      start,
      this.scanner.position,
      TokenType.LambdaExpression,
      {
        navigation: navigation.map((segment) => segment.name),
        operator,
        variable,
        predicate,
      }
    );
  }

  /** Собирает узел бинарного оператора. */
  private binary(type: TokenType, left: Token, right: Token): Token {
    return createToken(this.scanner.source, left.position, right.next, type, { left, right });
  }
}

/**
 * Разбирает выражение `$filter`.
 *
 * @param source - выражение без префикса `$filter=`; может быть закодировано `encodeURI`.
 * @returns корневой узел дерева.
 *
 * @throws {ODataParseError} выражение синтаксически некорректно либо содержит конструкцию,
 *   которой нет в грамматике (`$apply`, JSON-литералы). Конструкции, которые грамматика
 *   принимает, но транслировать в SQL нельзя (`replace`, `cast`, геофункции), доходят
 *   до обхода и отвергаются там как `ODataUnsupportedError` — так в сообщении называется
 *   сама функция, а не позиция символа.
 *
 * @example
 * parseFilter("name eq 'Ada'");
 * // { type: 'EqualsExpression', value: { left: …, right: … }, raw: "name eq 'Ada'" }
 */
export function parseFilter(source: string): Token {
  const scanner = new Scanner(source);
  const expression = new ExpressionParser(scanner).parse();

  scanner.skipWhitespace();

  if (!scanner.atEnd) {
    scanner.fail('unexpected trailing characters');
  }

  return expression;
}
