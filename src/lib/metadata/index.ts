/**
 * @file Слой описания схемы сервиса — документ `$metadata` в формате CSDL XML.
 *
 * Два уровня, как и у остальной библиотеки:
 *
 * 1. `ODataMetadataMiddleware` — готовый обработчик Express, сам отправляет ответ
 *    с нужными заголовками;
 * 2. `createMetadataDocument` — только генерация строки, без HTTP. Подходит для NestJS,
 *    Fastify, записи схемы в файл и тестов.
 */
export * from './createMetadataDocument';
export * from './edmType';
export * from './ODataMetadataMiddleware';
export * from './types';
