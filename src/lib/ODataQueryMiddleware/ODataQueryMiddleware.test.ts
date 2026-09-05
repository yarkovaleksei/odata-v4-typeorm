/**
 * @file Тесты Express-обработчика.
 *
 * Основное, что здесь проверяется, — классификация ошибок. До этой версии любая ошибка
 * становилась `500`, а наружу уходил текст сообщения СУБД с именами таблиц и колонок
 * (дефект A-07). Тесты закрепляют новое поведение: клиентские ошибки → `400`,
 * детали остаются в логе.
 */
import type { NextFunction, Request, Response } from 'express';

import { Author } from '../../test/entity';
import { dataSource } from '../../test/setup/dataSource';
import { ODataQueryMiddleware } from './ODataQueryMiddleware';

/**
 * Мок Response с фиксацией кода и тела ответа.
 *
 * Тип объявлен явно: методы возвращают сам объект (`res.status(…).json(…)`),
 * и без аннотации TypeScript не может вывести тип из-за циклической ссылки.
 */
function createResponse() {
  const state: { status?: number; body?: unknown } = {};

  const res: { status: jest.Mock; json: jest.Mock } = {
    status: jest.fn((code: number) => {
      state.status = code;

      return res;
    }),
    json: jest.fn((body: unknown) => {
      state.body = body;

      return res;
    }),
  };

  return { res: res as unknown as Response, state };
}

/** Выполняет обработчик и возвращает то, что он отправил клиенту. */
async function run(
  query: Record<string, string>,
  settings: Parameters<typeof ODataQueryMiddleware>[1] = {}
) {
  const { res, state } = createResponse();
  const next = jest.fn() as unknown as NextFunction;
  const logger = { error: jest.fn() };

  const handler = ODataQueryMiddleware(dataSource.getRepository(Author), {
    alias: 'Author',
    logger,
    ...settings,
  });

  await handler({ query } as unknown as Request, res, next);

  return { state, next: next as unknown as jest.Mock, logger };
}

describe('ODataQueryMiddleware', () => {
  describe('успешный запрос', () => {
    it('отвечает 200 и результатом executeQuery', async () => {
      const { state, next } = await run({ $filter: "name eq 'Ada'" });

      expect(state.status).toBe(200);
      expect(state.body).toEqual({
        items: [expect.objectContaining({ id: 1, name: 'Ada' })],
        count: 1,
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('пробрасывает опции выполнения', async () => {
      const { state } = await run({ $top: '100' }, { maxTop: 2 });

      expect((state.body as { items: unknown[] }).items).toHaveLength(2);
    });
  });

  describe('клиентские ошибки → 400', () => {
    it.each([
      ['некорректный синтаксис', { $filter: '!!!' }],
      ['неподдерживаемая функция', { $filter: 'geo.distance(a,b) lt 1' }],
      ['отрицательный $top', { $top: '-5' }],
    ])('%s', async (_name, query) => {
      const { state, next } = await run(query);

      expect(state.status).toBe(400);
      // Серверную цепочку не тревожим: это штатный сценарий, а не сбой.
      expect(next).not.toHaveBeenCalled();
    });

    it('несуществующая колонка отдаётся как 400 без деталей СУБД', async () => {
      const { state, logger } = await run({ $filter: 'nonexistent eq 1' });

      expect(state.status).toBe(400);
      expect(state.body).toEqual({ message: 'Invalid OData query.' });

      // Имя колонки не должно просочиться в ответ — по нему перебирается схема БД.
      expect(JSON.stringify(state.body)).not.toContain('nonexistent');

      // Но в логе полное сообщение остаётся.
      expect(logger.error).toHaveBeenCalledWith('ODATA ERROR', expect.any(Error));
    });

    it('exposeErrors раскрывает текст ошибки СУБД', async () => {
      const { state } = await run({ $filter: 'nonexistent eq 1' }, { exposeErrors: true });

      expect(state.status).toBe(400);
      // Сам текст у каждой СУБД свой; важно, что он отличается от нейтральной заглушки.
      expect(state.body).not.toEqual({ message: 'Invalid OData query.' });
      expect((state.body as { message: string }).message.length).toBeGreaterThan(0);
    });

    it('нарушение белого списка отдаётся как 400', async () => {
      const { state } = await run({ $select: 'bio' }, { allowedFields: ['id', 'name'] });

      expect(state.status).toBe(400);
    });
  });

  describe('серверные ошибки → 500', () => {
    it('неизвестная ошибка маскируется и уходит в next', async () => {
      const { res, state } = createResponse();
      const next = jest.fn();
      const logger = { error: jest.fn() };

      const boom = new Error('соединение с базой потеряно');
      const brokenRepository = {
        createQueryBuilder: () => {
          throw boom;
        },
      };

      const handler = ODataQueryMiddleware(brokenRepository as never, {
        alias: 'Author',
        logger,
      });

      await handler({ query: {} } as unknown as Request, res, next as unknown as NextFunction);

      expect(state.status).toBe(500);
      expect(state.body).toEqual({ message: 'Internal server error.' });

      // Текст внутренней ошибки наружу не отдаётся...
      expect(JSON.stringify(state.body)).not.toContain('соединение');
      // ...но доходит до общего обработчика приложения.
      expect(next).toHaveBeenCalledWith(boom);
      expect(logger.error).toHaveBeenCalledWith('ODATA ERROR', boom);
    });
  });

  describe('логирование', () => {
    it('по умолчанию используется console.error', async () => {
      const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      const { res } = createResponse();
      const handler = ODataQueryMiddleware(dataSource.getRepository(Author), { alias: 'Author' });

      await handler(
        { query: { $filter: '!!!' } } as unknown as Request,
        res,
        jest.fn() as unknown as NextFunction
      );

      expect(spy).toHaveBeenCalledWith('ODATA ERROR', expect.any(Error));

      spy.mockRestore();
    });
  });
});
