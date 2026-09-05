/**
 * @file Express-middleware: читает OData-параметры из `req.query`, выполняет запрос через TypeORM
 * и отвечает JSON-ом.
 *
 * Несмотря на название, это не промежуточный обработчик, а конечный: он сам отправляет ответ
 * и не передаёт управление дальше по цепочке (хотя `next()` и вызывается — см. ниже).
 * Ставить его нужно последним в маршруте.
 */
import type { Request, Response, NextFunction } from 'express';
import type { ObjectLiteral, Repository, SelectQueryBuilder } from 'typeorm';

import { executeQuery } from '../executeQuery';
import type { QueryParams } from '../types';

/** Настройки middleware: опциональный логгер ошибок и алиас корня для QueryBuilder. */
interface ODataQueryMiddlewareSettings {
  /**
   * Куда писать ошибки выполнения. Интерфейс намеренно минимальный (только `error`),
   * чтобы подходили и `console`, и pino/winston, и NestJS-логгер. По умолчанию — `console`.
   */
  logger?: {
    error: (text: string, ...args: unknown[]) => void;
  };
  /** Алиас корневой сущности; должен совпадать с именем сущности или её таблицы. */
  alias?: string;
}

/**
 * Фабрика middleware для маршрута Express.
 *
 * @param repositoryOrQueryBuilder - либо `Repository` (будет создан `createQueryBuilder(alias)`),
 *   либо уже настроенный `SelectQueryBuilder`. Объект захватывается замыканием один раз,
 *   поэтому ограничения, зависящие от конкретного запроса (текущий пользователь, тенант),
 *   так задать нельзя — для них нужен собственный обработчик поверх `executeQuery`.
 * @param settings - `alias` пробрасывается в `executeQuery`; при ошибке вызывается
 *   `settings.logger.error`, иначе `console.error`.
 * @returns async handler `(req, res, next)`.
 *
 * @remarks Поведение ответа:
 * - успех → `200` и тело результата `executeQuery` (массив либо `{ items, count }`);
 * - исключение → `500` с телом `{ message, error: { message } }`.
 *
 * Два известных изъяна обработки ошибок:
 * 1. Любая ошибка становится `500`, включая заведомо клиентские — синтаксически неверный `$filter`
 *    или несуществующая колонка. Правильнее отдавать `400`.
 * 2. Наружу отдаётся `e.message`. Для `QueryFailedError` из TypeORM это текст ошибки СУБД,
 *    раскрывающий имена таблиц и колонок. См. `docs/audit.md`, дефект A-07.
 *
 * `next()` вызывается всегда, в том числе после уже отправленного ответа. Express такой вызов
 * переживает (следующие обработчики упрутся в `res.headersSent`), но полагаться на это не стоит:
 * если после этого маршрута стоит ещё один обработчик, он получит управление на завершённом ответе.
 * См. `docs/roadmap.md`, задача R-28.
 */
export function ODataQueryMiddleware<T extends ObjectLiteral = ObjectLiteral>(
  repositoryOrQueryBuilder: Repository<T> | SelectQueryBuilder<T>,
  settings: ODataQueryMiddlewareSettings = {}
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const defaultAlias = '';

    try {
      const result = await executeQuery(
        repositoryOrQueryBuilder,
        // Express кладёт query в строковый вид; приводим к контракту QueryParams.
        req.query as unknown as QueryParams,
        {
          alias: settings?.alias ?? defaultAlias,
        }
      );

      return res.status(200).json(result);
    } catch (e) {
      if (settings && typeof settings.logger !== 'undefined') {
        settings.logger.error('ODATA ERROR', e);
      } else {
        console.error('ODATA ERROR', e);
      }

      res.status(500).json({
        message: 'Internal server error.',
        error: { message: (e as Error).message },
      });
    }

    // Вызывается и после успеха, и после ошибки — ответ к этому моменту уже отправлен.
    return next();
  };
}
