/**
 * @file Express-middleware: читает OData-параметры из `req.query`, выполняет запрос через TypeORM
 * и отвечает JSON-ом.
 *
 * Несмотря на название, это не промежуточный обработчик, а конечный: он сам отправляет ответ.
 * Ставить его нужно последним в маршруте.
 */
import type { NextFunction, Request, Response } from 'express';
import type { ObjectLiteral, Repository, SelectQueryBuilder } from 'typeorm';
import { QueryFailedError } from 'typeorm';

import { isODataClientError } from '../errors';
import { executeQuery } from '../executeQuery';
import type { ExecuteQueryOptions } from '../executeQuery/types';
import type { QueryParams } from '../types';

/** Настройки middleware. */
interface ODataQueryMiddlewareSettings extends ExecuteQueryOptions {
  /**
   * Куда писать ошибки выполнения. Интерфейс намеренно минимальный (только `error`),
   * чтобы подходили и `console`, и pino/winston, и NestJS-логгер. По умолчанию — `console`.
   */
  logger?: {
    error: (text: string, ...args: unknown[]) => void;
  };

  /**
   * Включать ли текст исходной ошибки в тело HTTP-ответа.
   *
   * По умолчанию `false`, и это важно: сообщение `QueryFailedError` из TypeORM — это текст
   * ошибки СУБД, раскрывающий имена таблиц и колонок. Подбирая `$filter=<имя> eq 1`, клиент
   * перечислил бы схему по одному полю за запрос.
   *
   * Включайте только в средах разработки.
   *
   * @defaultValue `false`
   */
  exposeErrors?: boolean;
}

/** Что именно отдавать клиенту по конкретной ошибке. */
interface ErrorResponse {
  status: number;
  message: string;
}

/**
 * Классификация ошибки: вина клиента или сервера.
 *
 * Три источника клиентских ошибок:
 * 1. Ошибки самой библиотеки с признаком `isClientError` — некорректный синтаксис OData,
 *    неподдерживаемая конструкция, недопустимое значение параметра.
 * 2. `QueryFailedError` из TypeORM. Сюда почти всегда приводит несуществующая колонка
 *    в `$filter` или `$orderby` — имена полей по метаданным не проверяются. Настоящий сбой
 *    БД (нет соединения, таймаут) даёт другие классы ошибок и попадает в ветку `500`.
 * 3. Всё остальное — `500`.
 *
 * Текст ошибки наружу не уходит: в `500` он бесполезен клиенту, а в `400` может раскрыть
 * схему БД. Полное сообщение всегда пишется в лог.
 */
function classifyError(error: unknown, exposeErrors: boolean): ErrorResponse {
  if (isODataClientError(error)) {
    // Эти сообщения библиотека формирует сама и знает, что в них нет деталей сервера.
    return { status: 400, message: error.message };
  }

  if (error instanceof QueryFailedError) {
    return {
      status: 400,
      message: exposeErrors ? error.message : 'Invalid OData query.',
    };
  }

  return {
    status: 500,
    message:
      exposeErrors && error instanceof Error ? error.message : 'Internal server error.',
  };
}

/**
 * Фабрика middleware для маршрута Express.
 *
 * @param repositoryOrQueryBuilder - либо `Repository` (будет создан `createQueryBuilder(alias)`),
 *   либо уже настроенный `SelectQueryBuilder`. Объект захватывается замыканием один раз,
 *   поэтому ограничения, зависящие от конкретного запроса (текущий пользователь, тенант),
 *   так задать нельзя — для них нужен собственный обработчик поверх `executeQuery`.
 * @param settings - всё, что принимает `executeQuery` (`alias`, `maxTop`, `allowedFields`,
 *   `allowedExpands`), плюс `logger` и `exposeErrors`.
 * @returns async handler `(req, res, next)`.
 *
 * @remarks Поведение ответа:
 *
 * | Ситуация | Код | Тело |
 * |---|---|---|
 * | Успех | `200` | результат `executeQuery` |
 * | Некорректный или неподдерживаемый запрос | `400` | `{ message }` |
 * | Ошибка SQL (обычно несуществующая колонка) | `400` | `{ message: 'Invalid OData query.' }` |
 * | Всё остальное | `500` | `{ message: 'Internal server error.' }` |
 *
 * `next(error)` вызывается только при `500` — чтобы ошибка дошла до общего обработчика
 * приложения. При успехе и при `400` цепочка останавливается: ответ уже отправлен,
 * и передавать управление дальше некуда.
 *
 * @example
 * app.get('/api/users', ODataQueryMiddleware(dataSource.getRepository(User), {
 *   alias: 'User',
 *   maxTop: 100,
 *   allowedExpands: ['posts'],
 *   logger: myLogger,
 * }));
 */
export function ODataQueryMiddleware<T extends ObjectLiteral = ObjectLiteral>(
  repositoryOrQueryBuilder: Repository<T> | SelectQueryBuilder<T>,
  settings: ODataQueryMiddlewareSettings = {}
) {
  const { logger = console, exposeErrors = false, ...queryOptions } = settings;

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await executeQuery(
        repositoryOrQueryBuilder,
        // Express кладёт query в строковый вид; приводим к контракту QueryParams.
        req.query as unknown as QueryParams,
        queryOptions
      );

      res.status(200).json(result);

      return;
    } catch (e) {
      const { status, message } = classifyError(e, exposeErrors);

      // Полное сообщение — всегда в лог, независимо от того, что ушло клиенту.
      logger.error('ODATA ERROR', e);

      res.status(status).json({ message });

      // Серверную ошибку пробрасываем дальше: пусть её увидят общий обработчик
      // приложения и системы наблюдения. Клиентскую — нет, это штатный сценарий.
      if (status >= 500) {
        return next(e);
      }

      return;
    }
  };
}
