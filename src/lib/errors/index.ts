/**
 * @file Ошибки библиотеки.
 *
 * Все они наследуют {@link ODataError} и несут признак `isClientError`, по которому
 * HTTP-слой отличает `400` от `500` без разбора текста сообщения.
 *
 * | Класс | Когда бросается | HTTP |
 * |---|---|---|
 * | {@link ODataParseError} | выражение не разобралось парсером | `400` |
 * | {@link ODataUnsupportedError} | конструкция вне поддерживаемого подмножества | `400` |
 * | {@link ODataInvalidQueryError} | значение параметра недопустимо | `400` |
 */
export * from './ODataError';
export * from './ODataInvalidQueryError';
export * from './ODataParseError';
export * from './ODataUnsupportedError';
