/**
 * @file Разбор строки системных query options: `$filter=…&$top=…&$expand=…`.
 *
 * ПОЧЕМУ НЕ `split('&')`. Амперсанд не экранируется `encodeURI`, поэтому он совершенно
 * законно встречается внутри строкового литерала: `$filter=name eq 'A&B'`. Разбиение строки
 * по разделителю разорвало бы такой литерал пополам. Здесь опции разбираются тем же курсором,
 * что и выражения, и `&` внутри литерала до разделителя просто не доходит. То же касается
 * запятых и точек с запятой внутри вложенных опций `$expand`.
 *
 * НЕИЗВЕСТНЫЕ ОПЦИИ отвергаются с указанием имени. Прежний парсер на `$apply` отвечал
 * `Fail at 0` — позицией начала строки, по которой нельзя понять, что именно не поддержано.
 */
import { ExpressionParser } from './parseFilter';
import { Scanner } from './scanner';
import { createToken, TokenType, type Token } from './token';

/** Системные опции, которые библиотека умеет транслировать. */
const KNOWN_OPTIONS = [
  '$filter',
  '$select',
  '$orderby',
  '$expand',
  '$top',
  '$skip',
  '$count',
  '$search',
  '$compute',
];

/**
 * Разбор строки query options.
 *
 * Курсор общий с разбором выражений: вложенные `$filter` внутри `$expand` читает тот же
 * {@link ExpressionParser}, поэтому позиция всегда одна и та же.
 */
class QueryOptionsParser {
  private readonly expressions: ExpressionParser;

  constructor(private readonly scanner: Scanner) {
    this.expressions = new ExpressionParser(scanner);
  }

  /**
   * Разбирает список опций до конца строки либо до закрывающей скобки вложенного `$expand`.
   *
   * @param separator - разделитель опций: `&` на верхнем уровне, `;` внутри `$expand(...)`.
   */
  public options(separator: '&' | ';'): Token[] {
    const options: Token[] = [];

    this.scanner.skipWhitespace();

    if (this.scanner.atEnd || this.scanner.at(')')) {
      return options;
    }

    do {
      options.push(this.option());
    } while (this.scanner.tryTake(separator));

    return options;
  }

  /** Одна опция вида `$имя=значение`. */
  private option(): Token {
    this.scanner.skipWhitespace();

    const start = this.scanner.position;

    this.scanner.take('$', 'a system query option starting with "$"');

    const name = `$${this.scanner.takeIdentifier('a system query option name')}`;

    if (!KNOWN_OPTIONS.includes(name)) {
      this.scanner.fail(`unsupported system query option "${name}"`);
    }

    this.scanner.take('=');

    switch (name) {
      case '$filter':
        return this.wrap(start, TokenType.Filter, this.expressions.parse());
      case '$select':
        return this.list(start, TokenType.Select, TokenType.SelectItem, () => this.pathItem());
      case '$orderby':
        return this.list(start, TokenType.OrderBy, TokenType.OrderByItem, () => this.orderByItem());
      case '$expand':
        return this.list(start, TokenType.Expand, TokenType.ExpandItem, () => this.expandItem());
      case '$compute':
        return this.list(start, TokenType.Compute, TokenType.ComputeItem, () => this.computeItem());
      case '$top':
        return this.wrap(start, TokenType.Top, this.integer());
      case '$skip':
        return this.wrap(start, TokenType.Skip, this.integer());
      case '$count':
        return this.wrap(start, TokenType.InlineCount, this.boolean());
      default:
        return this.wrap(start, TokenType.Search, this.rest());
    }
  }

  /** Опция с единственным значением: `$filter`, `$top`, `$count`. */
  private wrap(start: number, type: TokenType, value: Token): Token {
    return createToken(this.scanner.source, start, this.scanner.position, type, value);
  }

  /**
   * Опция со списком через запятую: `$select`, `$orderby`, `$expand`.
   *
   * Элементы оборачиваются в собственный узел, потому что посетитель читает их `raw`:
   * для `$select` это путь свойства, для `$expand` — имя связи.
   */
  private list(
    start: number,
    type: TokenType,
    itemType: TokenType,
    parseItem: () => { value: unknown; start: number }
  ): Token {
    const items: Token[] = [];

    do {
      const item = parseItem();

      items.push(
        createToken(this.scanner.source, item.start, this.scanner.position, itemType, item.value)
      );
    } while (this.scanner.tryTake(','));

    return createToken(this.scanner.source, start, this.scanner.position, type, { items });
  }

  /** Путь свойства для `$select`: `id`, `author/name`. */
  private pathItem(): { value: unknown; start: number } {
    this.scanner.skipWhitespace();

    const start = this.scanner.position;
    const segments = [this.scanner.takeIdentifier('a property name')];

    while (this.scanner.at('/')) {
      this.scanner.position += 1;
      segments.push(this.scanner.takeIdentifier('a property name'));
    }

    return { value: { path: segments }, start };
  }

  /**
   * Элемент `$orderby`: выражение и направление.
   *
   * Направление хранится числом (`1` / `-1`) — так его читает посетитель, доставшийся
   * от прежней библиотеки; менять представление ради красоты значило бы трогать и его.
   */
  private orderByItem(): { value: unknown; start: number } {
    this.scanner.skipWhitespace();

    const start = this.scanner.position;
    const expr = this.expressions.parse();

    let direction = 1;

    if (this.scanner.tryTakeKeyword('desc')) {
      direction = -1;
    } else {
      this.scanner.tryTakeKeyword('asc');
    }

    return { value: { expr, direction }, start };
  }

  /**
   * Элемент `$compute`: выражение и имя, под которым оно становится доступно.
   *
   * Форма `<выражение> as <имя>` (раздел 11.2.4.9 спецификации). Ключевое слово `as`
   * распознаётся как ключевое, а не как идентификатор: иначе `price mul qty as total`
   * читалось бы как путь свойства `as`, и ошибка указывала бы не туда.
   *
   * Имя проверяется здесь только на форму идентификатора. Столкновение с именем свойства
   * сущности отвергает посетитель: знать состав сущности парсеру неоткуда.
   */
  private computeItem(): { value: unknown; start: number } {
    this.scanner.skipWhitespace();

    const start = this.scanner.position;
    const expr = this.expressions.parse();

    if (!this.scanner.tryTakeKeyword('as')) {
      this.scanner.fail('expected "as" followed by a name for the computed expression');
    }

    this.scanner.skipWhitespace();

    const name = this.scanner.takeIdentifier('a name for the computed expression');

    return { value: { expr, name }, start };
  }

  /** Элемент `$expand`: имя связи и, возможно, вложенные опции в скобках. */
  private expandItem(): { value: unknown; start: number } {
    this.scanner.skipWhitespace();

    const start = this.scanner.position;

    this.scanner.takeIdentifier('a navigation property name');

    const path = createToken(
      this.scanner.source,
      start,
      this.scanner.position,
      TokenType.ExpandPath,
      { path: this.scanner.source.slice(start, this.scanner.position) }
    );

    if (!this.scanner.at('(')) {
      return { value: { path }, start };
    }

    this.scanner.take('(');

    const options = this.options(';');

    this.scanner.take(')');

    return { value: { path, options }, start };
  }

  /** Целое число для `$top` / `$skip`. */
  private integer(): Token {
    this.scanner.skipWhitespace();

    const start = this.scanner.position;

    if (this.scanner.at('-')) {
      this.scanner.position += 1;
    }

    while (!this.scanner.atEnd && /\d/.test(this.scanner.current)) {
      this.scanner.position += 1;
    }

    if (this.scanner.position === start) {
      this.scanner.fail('expected an integer');
    }

    return createToken(
      this.scanner.source,
      start,
      this.scanner.position,
      TokenType.Literal,
      'Edm.Int64'
    );
  }

  /** Логическое значение для `$count`. */
  private boolean(): Token {
    this.scanner.skipWhitespace();

    const start = this.scanner.position;

    if (!this.scanner.tryTakeKeyword('true') && !this.scanner.tryTakeKeyword('false')) {
      this.scanner.fail('expected "true" or "false"');
    }

    return createToken(
      this.scanner.source,
      start,
      this.scanner.position,
      TokenType.Literal,
      'Edm.Boolean'
    );
  }

  /**
   * Остаток значения до разделителя опций — для `$search`.
   *
   * Грамматику `$search` разбирает отдельный модуль (`parseSearch`), и до посетителя эта
   * опция в обычном конвейере не доходит: `executeQueryByQueryBuilder` отделяет её раньше.
   * Здесь она читается только чтобы не отвергать строку, где `$search` записан вместе
   * с остальными опциями.
   */
  private rest(): Token {
    const start = this.scanner.position;

    while (!this.scanner.atEnd && !this.scanner.at('&')) {
      if (this.scanner.at("'")) {
        this.scanner.takeStringLiteral();
        continue;
      }

      this.scanner.position += 1;
    }

    return createToken(
      this.scanner.source,
      start,
      this.scanner.position,
      TokenType.Literal,
      'Edm.String'
    );
  }
}

/**
 * Разбирает строку системных query options.
 *
 * @param source - строка вида `$filter=…&$top=…`; может быть закодирована `encodeURI`.
 * @returns узел `QueryOptions` со списком разобранных опций.
 *
 * @throws {ODataParseError} строка синтаксически некорректна либо содержит опцию,
 *   которую библиотека не поддерживает.
 * @throws {ODataUnsupportedError} выражение внутри опции содержит неподдерживаемую конструкцию.
 *
 * @example
 * parseQueryOptions("$filter=age gt 18&$top=10");
 * // { type: 'QueryOptions', value: { options: [ { type: 'Filter', … }, { type: 'Top', … } ] } }
 */
export function parseQueryOptions(source: string): Token {
  const scanner = new Scanner(source);
  const options = new QueryOptionsParser(scanner).options('&');

  scanner.skipWhitespace();

  if (!scanner.atEnd) {
    scanner.fail('unexpected trailing characters');
  }

  return createToken(source, 0, source.length, TokenType.QueryOptions, { options });
}
