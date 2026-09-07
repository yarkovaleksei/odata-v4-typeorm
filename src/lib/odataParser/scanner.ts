/**
 * @file Курсор по строке запроса: пробелы, имена, литералы, символы-разделители.
 *
 * ПРО ПРОЦЕНТНОЕ КОДИРОВАНИЕ. В парсер приходит строка после `encodeURI` (см.
 * `queryToOdataString`), поэтому пробел выглядит как `%20`, а нелатинские буквы и `%` —
 * как последовательности `%XX`. Разделителем слов поэтому считается и `%20`. Содержимое
 * литералов при этом остаётся закодированным: раскодировать его — дело `Literal.convert`,
 * который знает тип значения. Так же вёл себя и прежний парсер.
 */
import { ODataParseError } from '../errors';

/** Регулярное выражение имени: буква или подчёркивание, дальше буквы, цифры, подчёркивания. */
const IDENTIFIER_START = /[A-Za-z_]/;
const IDENTIFIER_PART = /[A-Za-z0-9_]/;

/**
 * Курсор по разбираемой строке.
 *
 * Класс, а не набор функций с индексом: позиция меняется на каждом шаге разбора, и таскать
 * её через все функции пришлось бы вручную. Все методы, начинающиеся с `try`, при неуспехе
 * оставляют позицию нетронутой — на этом держится откат в местах, где грамматика неоднозначна.
 */
export class Scanner {
  /** Текущая позиция в строке. */
  public position = 0;

  constructor(public readonly source: string) {}

  /** Достигнут ли конец строки. */
  public get atEnd(): boolean {
    return this.position >= this.source.length;
  }

  /** Символ в текущей позиции (или пустая строка в конце). */
  public get current(): string {
    return this.source[this.position] ?? '';
  }

  /**
   * Пропускает пробельные символы, включая закодированные `%20`.
   *
   * `+` пробелом НЕ считается: в OData он значим внутри значений даты со смещением
   * (`2020-01-01T00:00:00+03:00`), а строку запроса сериализует `encodeURI`, который
   * пробел кодирует именно как `%20`.
   */
  public skipWhitespace(): void {
    for (;;) {
      const char = this.current;

      if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
        this.position += 1;
        continue;
      }

      if (this.source.startsWith('%20', this.position)) {
        this.position += 3;
        continue;
      }

      return;
    }
  }

  /**
   * Есть ли в текущей позиции указанный текст — БЕЗ пропуска пробелов.
   *
   * Нужен там, где пробел значим: между сегментами пути и перед скобкой вызова функции
   * его быть не может, и `author / name` — не путь, а ошибка.
   */
  public at(text: string): boolean {
    return this.source.startsWith(text, this.position);
  }

  /** Есть ли в текущей позиции указанный текст (после пропуска пробелов). */
  public peek(text: string): boolean {
    this.skipWhitespace();

    return this.source.startsWith(text, this.position);
  }

  /** Съедает указанный текст, если он есть в текущей позиции. */
  public tryTake(text: string): boolean {
    if (!this.peek(text)) {
      return false;
    }

    this.position += text.length;

    return true;
  }

  /**
   * Съедает указанный текст или сообщает об ошибке.
   *
   * @throws {ODataParseError} если в текущей позиции другой текст.
   */
  public take(text: string, what = `"${text}"`): void {
    if (!this.tryTake(text)) {
      this.fail(`expected ${what}`);
    }
  }

  /**
   * Съедает ключевое слово — имя целиком, а не префикс.
   *
   * Проверка следующего символа обязательна: без неё `andrew eq 1` разобралось бы как
   * оператор `and`, за которым идёт мусор `rew`.
   */
  public tryTakeKeyword(keyword: string): boolean {
    this.skipWhitespace();

    if (!this.source.startsWith(keyword, this.position)) {
      return false;
    }

    const after = this.source[this.position + keyword.length] ?? '';

    if (after !== '' && IDENTIFIER_PART.test(after)) {
      return false;
    }

    this.position += keyword.length;

    return true;
  }

  /** Показывает следующее ключевое слово, не съедая его. */
  public peekKeyword(keyword: string): boolean {
    const saved = this.position;
    const found = this.tryTakeKeyword(keyword);

    this.position = saved;

    return found;
  }

  /**
   * Читает имя (свойства, функции, переменной лямбды).
   *
   * @returns имя либо `undefined`, если в текущей позиции имя не начинается.
   */
  public tryTakeIdentifier(): string | undefined {
    this.skipWhitespace();

    if (!IDENTIFIER_START.test(this.current)) {
      return undefined;
    }

    const start = this.position;

    while (!this.atEnd && IDENTIFIER_PART.test(this.current)) {
      this.position += 1;
    }

    return this.source.slice(start, this.position);
  }

  /**
   * Читает имя или сообщает об ошибке.
   *
   * @throws {ODataParseError} если имени в текущей позиции нет.
   */
  public takeIdentifier(what = 'an identifier'): string {
    const name = this.tryTakeIdentifier();

    if (name === undefined) {
      this.fail(`expected ${what}`);
    }

    return name;
  }

  /**
   * Читает строковый литерал в одинарных кавычках вместе с кавычками.
   *
   * Удвоенная кавычка внутри (`'it''s'`) — способ записать саму кавычку, как в SQL
   * и как требует спецификация OData (раздел 5.1.1.11.1). Раскодированием процентных
   * последовательностей и снятием кавычек занимается уже `Literal.convert`.
   *
   * @throws {ODataParseError} если литерал не закрыт.
   */
  public takeStringLiteral(): string {
    const start = this.position;

    this.position += 1;

    for (;;) {
      if (this.atEnd) {
        this.position = start;
        this.fail('unterminated string literal');
      }

      if (this.current === "'") {
        // Удвоенная кавычка — часть значения, а не конец литерала.
        if (this.source[this.position + 1] === "'") {
          this.position += 2;
          continue;
        }

        this.position += 1;

        return this.source.slice(start, this.position);
      }

      this.position += 1;
    }
  }

  /**
   * Сообщает о синтаксической ошибке с указанием позиции.
   *
   * @throws {ODataParseError} всегда.
   */
  public fail(reason: string): never {
    throw new ODataParseError(this.source, new Error(`${reason} at ${this.position}`));
  }
}
