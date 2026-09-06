/**
 * @file Тесты обработчика маршрута `$metadata`.
 *
 * Проверяется то, из-за чего клиент вроде `ra-data-odata-server` не прочитает ответ,
 * даже если сам документ верен: тип содержимого, заголовок версии протокола и код ответа.
 * Плюс поведение кэша — документ строится один раз, но неудачная попытка не запоминается.
 */
import type { NextFunction, Request, Response } from 'express';
import type { DataSourceOptions } from 'typeorm';
import { DataSource } from 'typeorm';

import { Tag } from '../../../test/fixtures';
import { buildDataSourceOptions } from '../../../test/setup/dataSource';
import { ODataMetadataMiddleware } from './ODataMetadataMiddleware';

/**
 * Параметры подключения: своя база на каждый тест, чтобы её можно было закрывать,
 * не трогая общую.
 *
 * `synchronize: false` обязателен. Схема уже создана общим подключением, а повторный
 * `synchronize` из второго подключения к тем же PostgreSQL или MySQL подрался бы с ним
 * за системный каталог. Документу `$metadata` схема в базе и не нужна — он строится
 * по метаданным TypeORM.
 */
const options: DataSourceOptions = { ...buildDataSourceOptions(), synchronize: false };

/**
 * Мок Response с фиксацией кода, заголовков и тела ответа.
 *
 * Тип объявлен явно: методы возвращают сам объект (`res.type(…).status(…).send(…)`),
 * и без аннотации TypeScript не может вывести тип из-за циклической ссылки.
 */
function createResponse() {
  const state: {
    status?: number;
    body?: unknown;
    contentType?: string;
    headers: Record<string, string>;
  } = { headers: {} };

  const res: {
    setHeader: jest.Mock;
    type: jest.Mock;
    status: jest.Mock;
    send: jest.Mock;
    json: jest.Mock;
  } = {
    setHeader: jest.fn((name: string, value: string) => {
      state.headers[name] = value;

      return res;
    }),
    type: jest.fn((value: string) => {
      state.contentType = value;

      return res;
    }),
    status: jest.fn((code: number) => {
      state.status = code;

      return res;
    }),
    send: jest.fn((body: unknown) => {
      state.body = body;

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
function run(handler: ReturnType<typeof ODataMetadataMiddleware>) {
  const { res, state } = createResponse();
  const next = jest.fn() as unknown as NextFunction;

  handler({} as Request, res, next);

  return { state, next: next as unknown as jest.Mock };
}

/** Логгер-заглушка: иначе ожидаемые ошибки засоряют вывод прогона. */
const logger = { error: jest.fn() };

describe('ODataMetadataMiddleware', () => {
  let dataSource: DataSource;

  beforeEach(async () => {
    jest.clearAllMocks();

    dataSource = new DataSource(options);

    await dataSource.initialize();
  });

  afterEach(async () => {
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  });

  describe('успешный ответ', () => {
    it('отдаёт XML, а не JSON', () => {
      const { state } = run(ODataMetadataMiddleware(dataSource, { logger, entities: [Tag] }));

      // Ради этого обработчик и существует: клиенты OData разбирают `$metadata` как XML,
      // и JSON-представление модели, хотя и описано в спецификации, им не подходит.
      expect(state.status).toBe(200);
      expect(state.contentType).toBe('application/xml');
      expect(String(state.body)).toContain('<edmx:Edmx');
      expect(String(state.body)).toContain('<EntitySet Name="Tag" EntityType="Default.Tag"/>');
    });

    it('объявляет версию протокола заголовком', () => {
      const { state } = run(ODataMetadataMiddleware(dataSource, { logger }));

      expect(state.headers['OData-Version']).toBe('4.0');
    });

    it('настройки документа передаются насквозь', () => {
      const { state } = run(
        ODataMetadataMiddleware(dataSource, { logger, namespace: 'Blog', containerName: 'Api' })
      );

      expect(String(state.body)).toContain('Namespace="Blog"');
      expect(String(state.body)).toContain('<EntityContainer Name="Api">');
    });

    it('не вызывает next при успехе', () => {
      const { next } = run(ODataMetadataMiddleware(dataSource, { logger }));

      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('кэширование', () => {
    it('документ строится один раз и переиспользуется', async () => {
      const handler = ODataMetadataMiddleware(dataSource, { logger });

      const first = run(handler);

      // Закрытое подключение — самый прямой способ убедиться, что второй ответ пришёл
      // из кэша: пересборка документа по нему невозможна и дала бы 500.
      await dataSource.destroy();

      const second = run(handler);

      expect(second.state.status).toBe(200);
      expect(second.state.body).toBe(first.state.body);
    });

    it('неудачная попытка не запоминается', async () => {
      const idle = new DataSource(options);
      const handler = ODataMetadataMiddleware(idle, { logger });

      // Типовой порядок в приложении: маршруты регистрируются до подключения к БД.
      // Ранний запрос не должен закрепить за обработчиком ошибку навсегда.
      expect(run(handler).state.status).toBe(500);

      await idle.initialize();

      expect(run(handler).state.status).toBe(200);

      await idle.destroy();
    });
  });

  describe('ошибки', () => {
    it('неинициализированный DataSource даёт 500 с нейтральным текстом', () => {
      const { state } = run(ODataMetadataMiddleware(new DataSource(options), { logger }));

      expect(state.status).toBe(500);
      expect(state.body).toEqual({ message: 'Internal server error.' });
    });

    it('подробности уходят в лог и в next', () => {
      const { next } = run(ODataMetadataMiddleware(new DataSource(options), { logger }));

      // Ошибка здесь всегда серверная, поэтому её должен увидеть и общий обработчик
      // приложения, и системы наблюдения.
      expect(logger.error).toHaveBeenCalledWith('ODATA METADATA ERROR', expect.any(Error));
      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });
});
