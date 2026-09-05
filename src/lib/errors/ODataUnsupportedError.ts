/**
 * @file Ошибка «конструкция OData не поддерживается».
 *
 * Существует ради одного правила: **библиотека никогда не должна молча отбрасывать часть
 * запроса**. Раньше базовый `Visitor` из `odata-v4-sql` на неизвестный тип узла AST печатал
 * строку в `console.log` и продолжал обход — из-за чего `$filter=not (…)` терял условие
 * целиком и возвращал всю таблицу вместо подмножества (дефект A-11).
 *
 * Клиент, чей фильтр не может быть выполнен, обязан получить отказ, а не чужие данные.
 */
import { ODataError } from './ODataError';

/**
 * Запрошена конструкция OData, которую библиотека не умеет транслировать в SQL.
 *
 * Ошибка **клиентская**: запрос синтаксически корректен, но выходит за пределы поддерживаемого
 * подмножества. На уровне HTTP её следует отдавать как `400`, а не `500`.
 *
 * @example
 * try {
 *   await executeQuery(repo, { $filter: 'geo.distance(a,b) lt 1' }, { alias: 'User' });
 * } catch (e) {
 *   if (e instanceof ODataUnsupportedError) {
 *     res.status(400).json({ message: e.message, feature: e.feature });
 *   }
 * }
 */
export class ODataUnsupportedError extends ODataError {
  public readonly isClientError = true;

  /** Имя узла AST либо функции OData, вызвавшей отказ (например `AnyExpression`, `geo.distance()`). */
  public readonly feature: string;

  /** Исходный фрагмент запроса, если парсер его сохранил. Удобно для сообщения пользователю. */
  public readonly fragment?: string;

  /**
   * @param feature - что именно не поддержано.
   * @param fragment - фрагмент исходной OData-строки.
   */
  constructor(feature: string, fragment?: string) {
    super(
      fragment
        ? `OData feature is not supported: ${feature} (in "${fragment}")`
        : `OData feature is not supported: ${feature}`,
      'ODataUnsupportedError'
    );

    this.feature = feature;
    this.fragment = fragment;
  }
}
