/**
 * @file Express-обработчик маршрута `$metadata`: отдаёт схему сервиса как CSDL XML.
 *
 * Как и `ODataQueryMiddleware`, это не промежуточный обработчик, а конечный — он сам
 * отправляет ответ и должен стоять последним в маршруте.
 *
 * Существует ради клиентов, которые строят интерфейс по схеме, а не по документации:
 * `ra-data-odata-server` (react-admin), `@odata/client`, Olingo, Excel. Все они первым
 * делом запрашивают `GET <корень сервиса>/$metadata` и разбирают ответ как XML —
 * JSON-представление модели, хотя и описано в спецификации, для них неприменимо.
 */
import type { NextFunction, Request, Response } from 'express';
import type { DataSource } from 'typeorm';

import { createMetadataDocument } from '../createMetadataDocument';
import type { MetadataDocumentOptions } from '../types';

/** Настройки обработчика. */
export interface ODataMetadataMiddlewareSettings extends MetadataDocumentOptions {
  /**
   * Куда писать ошибки. Интерфейс намеренно минимальный (только `error`), чтобы подходили
   * и `console`, и pino/winston, и NestJS-логгер.
   *
   * @defaultValue `console`
   */
  logger?: {
    error: (text: string, ...args: unknown[]) => void;
  };
}

/**
 * Фабрика обработчика маршрута `$metadata`.
 *
 * @param dataSource - источник данных TypeORM. Может быть ещё не инициализирован в момент
 *   регистрации маршрута: документ строится при первом запросе, а не здесь.
 * @param settings - всё, что принимает `createMetadataDocument` (`namespace`, `entities`,
 *   `entitySetName`, `includeHiddenColumns`, `edmType`), плюс `logger`.
 * @returns handler `(req, res, next)`.
 *
 * @remarks Ответ: `200` с телом CSDL XML, заголовками `Content-Type: application/xml`
 *   и `OData-Version: 4.0`. Любая ошибка — `500` с нейтральным текстом; подробности
 *   уходят в лог и в `next(error)`. Клиентских ошибок здесь не бывает: документ не зависит
 *   от содержимого запроса, поэтому и `400` возникнуть не может.
 *
 * ПРО КЭШИРОВАНИЕ. Документ строится один раз и переиспользуется: набор сущностей
 * после `initialize()` уже не меняется. Неудачная попытка не запоминается — иначе
 * обработчик, зарегистрированный до инициализации подключения и задетый ранним запросом,
 * навсегда закрепил бы за собой ошибку.
 *
 * ПРО ПУТЬ МАРШРУТА. `$` в Express 5 — обычный символ, экранировать его не нужно,
 * но путь должен совпадать с корнем сервиса, от которого клиент считает адреса наборов:
 * если данные лежат на `/api/Authors`, то схема обязана быть на `/api/$metadata`.
 *
 * @example
 * app.get('/api/$metadata', ODataMetadataMiddleware(dataSource, { entities: [Author, Book] }));
 * app.get('/api/Authors', ODataQueryMiddleware(dataSource.getRepository(Author), { alias: 'Author' }));
 */
export function ODataMetadataMiddleware(
  dataSource: DataSource,
  settings: ODataMetadataMiddlewareSettings = {}
) {
  const { logger = console, ...documentOptions } = settings;

  let document: string | undefined;

  return (_req: Request, res: Response, next: NextFunction) => {
    try {
      document ??= createMetadataDocument(dataSource, documentOptions);

      // Заголовок обязателен по спецификации OData: по нему клиент понимает версию
      // протокола, не разбирая тело.
      res.setHeader('OData-Version', '4.0');

      res.type('application/xml').status(200).send(document);

      return;
    } catch (e) {
      logger.error('ODATA METADATA ERROR', e);

      res.status(500).json({ message: 'Internal server error.' });

      // Ошибка здесь всегда серверная (обычно неинициализированный DataSource либо
      // сущность вне подключения), поэтому её видит и общий обработчик приложения.
      return next(e);
    }
  };
}
