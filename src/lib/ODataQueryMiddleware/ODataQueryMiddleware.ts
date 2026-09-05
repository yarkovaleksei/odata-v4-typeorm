/**
 * Express-middleware: читает OData-параметры из `req.query`, выполняет запрос через TypeORM
 * и отвечает JSON-ом. Ошибки логируются и маскируются как 500 с кратким телом ответа.
 */
import type { Request, Response, NextFunction } from 'express';
import type { ObjectLiteral, Repository, SelectQueryBuilder } from 'typeorm';

import { executeQuery } from '../executeQuery';
import type { QueryParams } from '../types';

/** Настройки middleware: опциональный логгер ошибок и алиас корня для QueryBuilder. */
interface ODataQueryMiddlewareSettings {
  logger?: {
    error: (text: string, ...args: unknown[]) => void;
  };
  alias?: string;
}

/**
 * Фабрика middleware для маршрута Express.
 *
 * @param repositoryOrQueryBuilder - либо `Repository` (будет создан `createQueryBuilder(alias)`),
 *   либо уже настроенный `SelectQueryBuilder`.
 * @param settings - `alias` пробрасывается в `executeQuery`; при ошибке вызывается `logger.error`, иначе `console.error`.
 * @returns async handler `(req, res, next)`.
 *
 * Поведение ответа: при успехе — `200` и тело результата `executeQuery` (массив или `{ items, count }`);
 * при исключении — `500` с сообщением; после ветвления всегда вызывается `next()` (в т.ч. после отправки ответа).
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

    return next();
  };
}
