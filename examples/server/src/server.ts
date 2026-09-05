/**
 * @file Демо-сервер: OData-эндпоинты поверх TypeORM плюс интерактивный конструктор запросов.
 *
 * Запуск одной командой из корня репозитория:
 *
 * ```bash
 * yarn server
 * ```
 *
 * После старта:
 * - `http://localhost:3001/` — страница-конструктор: собрать запрос мышкой и увидеть ответ;
 * - `http://localhost:3001/api/posts` — сам OData-эндпоинт;
 * - `http://localhost:3001/api/posts/$metadata` — список полей и связей сущности.
 */
import * as path from 'path';

import express, { type Request, type Response } from 'express';
import type { EntityTarget, ObjectLiteral } from 'typeorm';

import { executeQuery, isODataClientError, type QueryParams } from 'odata-v4-typeorm-improved';

import { dataSource } from './dataSource';
import { Author } from './entities/author';
import { Post } from './entities/post';
import { PostCategory } from './entities/postCategory';
import { PostComment } from './entities/postComment';
import { User } from './entities/user';
import { seed } from './seed';

/**
 * Сущности, доступные через API.
 *
 * Ключ — сегмент пути (`/api/posts`), значение — класс сущности и алиас. Алиас совпадает
 * с именем класса: он идёт в SQL префиксом колонок, и совпадение делает генерируемые
 * запросы читаемыми в логе.
 */
const RESOURCES = {
  posts: { entity: Post, alias: 'Post' },
  authors: { entity: Author, alias: 'Author' },
  users: { entity: User, alias: 'User' },
  categories: { entity: PostCategory, alias: 'PostCategory' },
  comments: { entity: PostComment, alias: 'PostComment' },
} as const satisfies Record<string, { entity: EntityTarget<ObjectLiteral>; alias: string }>;

type ResourceName = keyof typeof RESOURCES;

/**
 * Описание полей и связей сущности для конструктора.
 *
 * Страница подставляет эти имена в подсказки, чтобы не приходилось помнить схему наизусть.
 */
function describeResource(name: ResourceName) {
  const { entity, alias } = RESOURCES[name];
  const metadata = dataSource.getMetadata(entity);

  return {
    name,
    alias,
    fields: metadata.columns
      // Колонки внешних ключей скрыты: они дублируют связь и в $select бесполезны.
      .filter((column) => !column.relationMetadata)
      .map((column) => ({
        name: column.propertyName,
        type: typeof column.type === 'function' ? column.type.name.toLowerCase() : String(column.type),
        nullable: column.isNullable,
      })),
    relations: metadata.relations.map((relation) => ({
      name: relation.propertyPath,
      target: relation.inverseEntityMetadata.name,
      collection: relation.isOneToMany || relation.isManyToMany,
    })),
  };
}

/**
 * Обработчик OData-запроса к одной сущности.
 *
 * Написан вручную, а не через `ODataQueryMiddleware`, чтобы демо показывало разбор ошибок:
 * клиентские отдаются как `400` с текстом, по которому видно, что именно не так в запросе.
 * Для конструктора это важнее, чем краткость.
 */
function odataHandler(name: ResourceName) {
  const { entity, alias } = RESOURCES[name];

  return async (request: Request, response: Response) => {
    try {
      const result = await executeQuery(
        dataSource.getRepository(entity),
        request.query as unknown as QueryParams,
        {
          alias,
          // Потолок страницы: демо открыто наружу, и без него один запрос вытянул бы всё.
          maxTop: 100,
        }
      );

      return response.status(200).json(result);
    } catch (error) {
      if (isODataClientError(error)) {
        return response.status(400).json({
          error: error.name,
          message: error.message,
        });
      }

      // Ошибка SQL (например несуществующая колонка) — тоже вина запроса, но текст
      // приходит от драйвера. В демо его показываем: он помогает понять опечатку.
      return response.status(400).json({
        error: 'QueryFailed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

export async function start(): Promise<void> {
  await dataSource.initialize();
  await seed();

  const app = express();

  // Страница-конструктор и её ресурсы.
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Схема всех сущностей — конструктор запрашивает её один раз при загрузке.
  app.get('/api/$metadata', (_request, response) => {
    response.json(Object.keys(RESOURCES).map((name) => describeResource(name as ResourceName)));
  });

  for (const name of Object.keys(RESOURCES) as ResourceName[]) {
    app.get(`/api/${name}/$metadata`, (_request, response) => {
      response.json(describeResource(name));
    });

    app.get(`/api/${name}`, odataHandler(name));
  }

  const port = Number(process.env.PORT ?? 3001);

  app.listen(port, () => {
    console.log(`Конструктор запросов: http://localhost:${port}/`);
    console.log(`OData-эндпоинт:       http://localhost:${port}/api/posts`);
  });
}

// Прямой запуск (`yarn serve`), а не импорт.
if (require.main === module) {
  start().catch((error) => {
    console.error('Не удалось запустить демо-сервер:', error);
    process.exitCode = 1;
  });
}
