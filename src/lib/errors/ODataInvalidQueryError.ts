/**
 * @file Ошибка «параметр запроса синтаксически разобран, но значение недопустимо».
 *
 * Отличается от {@link ODataParseError} тем, что здесь выражение прочиталось корректно —
 * не устраивает само значение: отрицательный `$top`, поле вне белого списка, размер страницы
 * сверх разрешённого.
 */
import { ODataError } from './ODataError';

/**
 * Значение параметра запроса недопустимо.
 *
 * Ошибка **клиентская** — на уровне HTTP ей соответствует `400 Bad Request`.
 *
 * @example
 * try {
 *   await executeQuery(repo, { $top: '-5' }, { alias: 'User' });
 * } catch (e) {
 *   if (e instanceof ODataInvalidQueryError) {
 *     res.status(400).json({ message: e.message, parameter: e.parameter });
 *   }
 * }
 */
export class ODataInvalidQueryError extends ODataError {
  public readonly isClientError = true;

  /** Имя параметра, вызвавшего отказ: `'$top'`, `'$select'`, `'$expand'`. */
  public readonly parameter: string;

  /**
   * @param parameter - имя параметра запроса.
   * @param reason - человекочитаемая причина; попадает в сообщение как есть, поэтому
   *   не должна содержать деталей устройства сервера или схемы БД.
   */
  constructor(parameter: string, reason: string) {
    super(`Invalid value for ${parameter}: ${reason}`, 'ODataInvalidQueryError');

    this.parameter = parameter;
  }
}
