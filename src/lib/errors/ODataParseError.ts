/**
 * @file Ошибка разбора OData-выражения.
 *
 * `odata-v4-parser` бросает обычный `Error` с текстом вида `Fail at 0` или
 * `Unexpected character at 9` — без типа, без позиции в машинно-читаемом виде и без
 * указания, какой параметр запроса виноват. Отличить такую ошибку от внутреннего сбоя
 * можно было только регулярным выражением по тексту сообщения.
 *
 * Этот класс оборачивает её один раз в точке разбора, где ещё известен исходный запрос.
 */
import { ODataError } from './ODataError';

/** Позиция в строке, о которой сообщил парсер (`Fail at 12` → `12`). */
const PARSER_POSITION = /\b(?:at|Fail at)\s+(\d+)/;

/**
 * OData-выражение не удалось разобрать.
 *
 * Ошибка **клиентская** — на уровне HTTP ей соответствует `400 Bad Request`.
 *
 * @example
 * try {
 *   createQuery('$filter=!!!', { alias: 'User' });
 * } catch (e) {
 *   if (e instanceof ODataParseError) {
 *     res.status(400).json({ message: 'Invalid OData query', position: e.position });
 *   }
 * }
 */
export class ODataParseError extends ODataError {
  public readonly isClientError = true;

  /** Разобранная строка (значение `$filter` либо полная query string). */
  public readonly source: string;

  /** Позиция символа, на котором споткнулся парсер; `undefined`, если он её не сообщил. */
  public readonly position?: number;

  /** Исходная ошибка парсера — на случай, если понадобятся детали при отладке. */
  public readonly cause?: unknown;

  /**
   * @param source - выражение, которое не удалось разобрать.
   * @param cause - исходная ошибка из `odata-v4-parser`.
   */
  constructor(source: string, cause?: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause ?? '');
    const position = PARSER_POSITION.exec(causeMessage)?.[1];

    super(
      `Failed to parse OData expression: "${source}"` +
        (position ? ` at position ${position}` : '') +
        (causeMessage ? ` (${causeMessage})` : ''),
      'ODataParseError'
    );

    this.source = source;
    this.position = position ? Number(position) : undefined;
    this.cause = cause;
  }
}
