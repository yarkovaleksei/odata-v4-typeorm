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
 * - `http://localhost:3001/api/books` — сам OData-эндпоинт;
 * - `http://localhost:3001/api/$metadata` — схема сервиса в CSDL XML, как её ждут
 *   клиенты OData (`ra-data-odata-server`, `@odata/client`, Excel);
 * - `http://localhost:3001/api/books/$schema` — список полей и связей сущности в JSON.
 *
 * ПРО ДВА РАЗНЫХ ОПИСАНИЯ СХЕМЫ. `$metadata` — стандартный путь OData, и по нему обязан
 * лежать документ CSDL XML: клиенты разбирают его как XML и на JSON не рассчитывают.
 * Конструктору же нужна не модель OData, а собственная выжимка (имена полей для подсказок),
 * поэтому она вынесена на `$schema` — путь, которого в спецификации нет и который ни с чем
 * не спутаешь.
 */
import { execFileSync } from 'child_process';
import * as path from 'path';

import express, { type Request, type Response } from 'express';
import type { EntityTarget, ObjectLiteral } from 'typeorm';

import {
  executeQuery,
  isODataClientError,
  ODataMetadataMiddleware,
  resolveEdmType,
  type QueryParams,
} from 'odata-v4-typeorm-improved';

import {
  Author,
  Book,
  BookDetails,
  Category,
  Post,
  Publisher,
  Review,
  seedDatabase,
  Tag,
  User,
} from '../../../src/test/fixtures';
import { dataSource } from './dataSource';

/**
 * Сущности, доступные через API.
 *
 * Ключ — сегмент пути (`/api/books`), значение — класс сущности и алиас. Алиас совпадает
 * с именем класса: он идёт в SQL префиксом колонок, и совпадение делает генерируемые
 * запросы читаемыми в логе.
 *
 * Опубликованы все сущности схемы, кроме представления `BookSummary` — у него нет
 * первичного ключа, и набором OData оно быть не может.
 */
const RESOURCES = {
  books: { entity: Book, alias: 'Book' },
  authors: { entity: Author, alias: 'Author' },
  reviews: { entity: Review, alias: 'Review' },
  publishers: { entity: Publisher, alias: 'Publisher' },
  categories: { entity: Category, alias: 'Category' },
  tags: { entity: Tag, alias: 'Tag' },
  details: { entity: BookDetails, alias: 'BookDetails' },
  users: { entity: User, alias: 'User' },
  posts: { entity: Post, alias: 'Post' },
} as const satisfies Record<string, { entity: EntityTarget<ObjectLiteral>; alias: string }>;

type ResourceName = keyof typeof RESOURCES;

/**
 * Сегмент маршрута по классу сущности — обратный к {@link RESOURCES} справочник.
 *
 * Нужен, чтобы имена наборов в `$metadata` совпали с адресами, по которым эти наборы
 * реально лежат: клиент берёт `EntitySet Name` и подставляет его в URL, поэтому набор
 * `Book` при маршруте `/api/books` привёл бы его в никуда.
 */
const ROUTE_BY_ENTITY = new Map<unknown, string>(
  (Object.keys(RESOURCES) as ResourceName[]).map((name) => [RESOURCES[name].entity, name])
);

/**
 * Описание полей и связей сущности для конструктора.
 *
 * Страница строит по нему всё, что зависит от схемы: список ресурсов, подсказки полей
 * под `$select` и `$expand` и готовые примеры запросов. Ничего из этого в разметке
 * не зашито — иначе правка сущности расходилась бы со страницей молча.
 *
 * `edmType` — тот же тип, что уходит в `$metadata` (`Edm.String`, `Edm.Int32`,
 * `Edm.DateTimeOffset`, …). Он и позволяет генерировать примеры по типу поля: для строки
 * уместен `contains`, для числа — сравнение, для даты — `year()`. Выводить это на клиенте
 * из имени типа колонки СУБД значило бы держать вторую копию той же таблицы соответствий,
 * которая уже есть в библиотеке.
 */
function describeResource(name: ResourceName) {
  const { entity, alias } = RESOURCES[name];
  const metadata = dataSource.getMetadata(entity);

  return {
    name,
    alias,
    fields: metadata.columns
      // Колонки внешних ключей скрыты: они дублируют связь и в $select бесполезны.
      // Колонки `select: false` — тоже: библиотека отвергает обращение к ним, и подсказка
      // в конструкторе вела бы прямиком в ошибку 400 (`User.passwordHash`).
      .filter((column) => !column.relationMetadata && column.isSelect)
      .map((column) => ({
        name: column.propertyName,
        type:
          typeof column.type === 'function' ? column.type.name.toLowerCase() : String(column.type),
        edmType: resolveEdmType(column),
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

/**
 * Компилирует код страницы из TypeScript в модули ES.
 *
 * Делается при каждом старте, а не отдельной командой: `nodemon` следит и за
 * `examples/server/client`, поэтому правка исходника перезапускает сервер и тут же
 * пересобирает страницу. Держать собранные файлы в репозитории при этом не нужно —
 * они в `.gitignore`.
 *
 * Ошибка компиляции роняет запуск намеренно. Отдать страницу, собранную из прошлой версии
 * исходника, значит показать поведение, которого в коде уже нет, — а разойтись они могут
 * незаметно, ровно как раньше расходились примеры со схемой.
 */
function buildClient(): void {
  const project = path.join(__dirname, '..', 'tsconfig.client.json');

  // Компилятор берётся из зависимостей проекта, а не из PATH: глобального tsc может
  // не быть, а версия глобального — отличаться от той, на которой всё проверялось.
  const tsc = require.resolve('typescript/bin/tsc');

  console.log('Сборка страницы конструктора…');

  execFileSync(process.execPath, [tsc, '--project', project], { stdio: 'inherit' });
}

export async function start(): Promise<void> {
  buildClient();

  await dataSource.initialize();
  await seedDatabase(dataSource);

  const app = express();

  // Страница-конструктор и её ресурсы.
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Схема сервиса в CSDL XML — то, что запрашивают настоящие клиенты OData.
  app.get(
    '/api/$metadata',
    ODataMetadataMiddleware(dataSource, {
      namespace: 'Demo',
      // Только то, что действительно опубликовано маршрутами: `$metadata` перечисляет
      // все поля и связи, то есть раскрывает схему БД, и служебным сущностям там не место.
      entities: Object.values(RESOURCES).map((resource) => resource.entity),
      entitySetName: (metadata) => ROUTE_BY_ENTITY.get(metadata.target) ?? metadata.name,
    })
  );

  // Выжимка для страницы-конструктора: не модель OData, а имена полей для подсказок.
  // Отдельный путь, потому что формат собственный и стандарту не подчиняется.
  app.get('/api/$schema', (_request, response) => {
    response.json(Object.keys(RESOURCES).map((name) => describeResource(name as ResourceName)));
  });

  for (const name of Object.keys(RESOURCES) as ResourceName[]) {
    app.get(`/api/${name}/$schema`, (_request, response) => {
      response.json(describeResource(name));
    });

    app.get(`/api/${name}`, odataHandler(name));
  }

  const port = Number(process.env.PORT ?? 3001);

  app.listen(port, () => {
    console.log(`Конструктор запросов: http://localhost:${port}/`);
    console.log(`OData-эндпоинт:       http://localhost:${port}/api/books`);
  });
}

// Прямой запуск (`yarn serve`), а не импорт.
if (require.main === module) {
  start().catch((error) => {
    console.error('Не удалось запустить демо-сервер:', error);
    process.exitCode = 1;
  });
}
