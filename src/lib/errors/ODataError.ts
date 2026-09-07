/**
 * @file Базовый класс ошибок библиотеки.
 *
 * Существует ради одного признака — {@link ODataError.isClientError}. Он позволяет HTTP-слою
 * отличить «клиент прислал плохой запрос» (`400`) от «у нас что-то сломалось» (`500`),
 * не разбирая текст сообщения регулярными выражениями.
 *
 * Раньше такого различия не было: `ODataQueryMiddleware` отдавал `500` на любую ошибку,
 * включая заведомо клиентские вроде опечатки в `$filter`. Мониторинг считал это отказом
 * сервиса, а клиент не понимал, что виноват сам.
 */

/**
 * Общий предок всех ошибок, которые библиотека бросает осознанно.
 *
 * Ошибки СУБД (`QueryFailedError` из TypeORM) сюда не входят — они приходят снаружи;
 * их классификацией занимается `ODataQueryMiddleware`.
 */
export abstract class ODataError extends Error {
  /**
   * `true`, если причина ошибки — содержимое запроса, а не состояние сервера.
   *
   * Такую ошибку следует отдавать как `400 Bad Request`: повтор того же запроса
   * не поможет, клиенту нужно его исправить.
   */
  public abstract readonly isClientError: boolean;

  protected constructor(message: string, name: string) {
    super(message);

    // Обязательно при компиляции в ES5/ES6: без восстановления прототипа
    // `e instanceof ODataError` возвращает false.
    Object.setPrototypeOf(this, new.target.prototype);

    this.name = name;
  }
}

/**
 * Проверяет, что ошибка порождена этой библиотекой и вызвана содержимым запроса.
 *
 * Удобно в обработчике HTTP: не нужно перечислять конкретные классы ошибок.
 *
 * @example
 * catch (e) {
 *   if (isODataClientError(e)) {
 *     return res.status(400).json({ message: e.message });
 *   }
 *
 *   throw e;
 * }
 */
export function isODataClientError(error: unknown): error is ODataError {
  return error instanceof ODataError && error.isClientError;
}
