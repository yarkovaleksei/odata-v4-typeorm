# Рецепты: Express

Подключение библиотеки к приложению на Express. Рецепты, не зависящие от фреймворка
(опции запроса, форма ответа, `$search`, лямбды, компиляция без TypeORM), —
в [recipes.md](./recipes.md); для NestJS есть [recipes-nestjs.md](./recipes-nestjs.md).

Готовые обработчики `ODataQueryMiddleware` и `ODataMetadataMiddleware` написаны под
сигнатуру Express `(req, res, next)`. Всё остальное строится поверх `executeQuery`,
которому нужен только объект параметров, — он не знает ни о каком HTTP.

---

## Минимальный эндпоинт

```ts
import express from 'express';
import { DataSource } from 'typeorm';
import { ODataQueryMiddleware } from 'odata-v4-typeorm-improved';

import { User } from './entities/User';

const dataSource = new DataSource({
  type: 'postgres',
  host: 'localhost',
  port: 5432,
  username: 'postgres',
  password: 'postgres',
  database: 'app',
  entities: [User],
});

await dataSource.initialize();

const app = express();

// alias обязан совпадать с именем класса сущности или именем её таблицы
app.get('/api/users', ODataQueryMiddleware(dataSource.getRepository(User), { alias: 'User' }));

app.listen(3001);
```

Проверка:

```bash
curl "http://localhost:3001/api/users?\$top=10&\$orderby=name%20asc"
```

Обработчик конечный — ставьте его последним в маршруте. `next(error)` он вызывает только
при `500`, чтобы ошибка дошла до общего обработчика приложения; при `400` цепочка
останавливается, это штатный сценарий.

---

## Свой обработчик (рекомендуется для публичного API)

`ODataQueryMiddleware` уже классифицирует ошибки сам. Свой обработчик нужен, когда важен
формат тела ответа или ограничения зависят от текущего запроса.

```ts
import { executeQuery, isODataClientError } from 'odata-v4-typeorm-improved';

app.get('/api/users', async (req, res) => {
  try {
    const result = await executeQuery(dataSource.getRepository(User), req.query, {
      alias: 'User',
      maxTop: 100,
    });

    return res.json(result);
  } catch (e) {
    logger.error('OData query failed', { query: req.query, error: e });

    // Признак isClientError несут все ошибки библиотеки — разбирать текст не нужно
    if (isODataClientError(e)) {
      return res.status(400).json({ message: e.message });
    }

    return res.status(500).json({ message: 'Internal server error.' });
  }
});
```

Обратите внимание: наружу не уходит текст неизвестной ошибки — он остаётся в логе.

---

## Единый обработчик ошибок

Чтобы не повторять `try/catch` в каждом маршруте, пробросьте ошибку в `next` и разберите
её один раз в error-middleware приложения:

```ts
import { NextFunction, Request, Response } from 'express';
import { executeQuery, isODataClientError } from 'odata-v4-typeorm-improved';
import { QueryFailedError } from 'typeorm';

app.get('/api/users', async (req, res, next) => {
  try {
    res.json(await executeQuery(dataSource.getRepository(User), req.query, {
      alias: 'User',
      maxTop: 100,
    }));
  } catch (e) {
    next(e);
  }
});

// последним в цепочке
app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
  if (isODataClientError(error)) {
    return res.status(400).json({ message: (error as Error).message });
  }

  // Несуществующая колонка в $filter или $orderby: имена по метаданным не проверяются,
  // поэтому такой запрос доходит до СУБД. Текст ошибки СУБД наружу отдавать не нужно.
  if (error instanceof QueryFailedError) {
    return res.status(400).json({ message: 'Invalid OData query.' });
  }

  logger.error('Unhandled error', { url: req.originalUrl, error });

  return res.status(500).json({ message: 'Internal server error.' });
});
```

> В Express 4 отклонённый промис в асинхронном обработчике до error-middleware не доходит —
> `try/catch` с `next(e)` обязателен. В Express 5 он подхватывается автоматически, но явный
> проброс не мешает и делает код переносимым между версиями.

---

## Права пользователя и мультиарендность

Ограничения, зависящие от текущего запроса, готовым middleware не задать: репозиторий
захватывается замыканием один раз при регистрации маршрута. Стройте `SelectQueryBuilder`
внутри обработчика — OData-условия добавятся к вашему через `andWhere`, обойти его нельзя.

```ts
app.get('/api/documents', async (req, res, next) => {
  try {
    const qb = dataSource
      .getRepository(Document)
      .createQueryBuilder('Document')
      .where('Document.ownerId = :ownerId', { ownerId: req.user.id });

    res.json(await executeQuery(qb, req.query, { maxTop: 100 }));
  } catch (e) {
    next(e);
  }
});
```

`alias` в опциях при готовом построителе можно не задавать: метаданные и корневой алиас
библиотека берёт у него самого.

---

## Конверт OData в ответе

`toODataEnvelope` из [общих рецептов](./recipes.md#ответ-в-формате-odata) остаётся тем же;
от Express нужен только адрес сервиса:

```ts
app.get('/api/users', async (req, res, next) => {
  try {
    const result = await executeQuery(dataSource.getRepository(User), req.query, {
      alias: 'User',
      maxTop: 100,
    });

    res.json(toODataEnvelope(result, `${req.protocol}://${req.get('host')}/api/$metadata#Users`));
  } catch (e) {
    next(e);
  }
});
```

За прокси `req.protocol` вернёт `http`, пока не включён `app.set('trust proxy', true)`, —
клиент получит контекст с неверной схемой.

---

## Схема сервиса на `$metadata`

```ts
import { ODataMetadataMiddleware } from 'odata-v4-typeorm-improved';

app.get('/api/$metadata', ODataMetadataMiddleware(dataSource, {
  namespace: 'Shop',
  entities: [Author, Book],
  entitySetName: (metadata) => metadata.tableName,
}));
```

Путь маршрута должен совпадать с корнем сервиса, от которого клиент считает адреса наборов:
если данные лежат на `/api/Authors`, схема обязана быть на `/api/$metadata`. В Express 5
`$` — обычный символ, экранировать его не нужно.

`dataSource` может быть ещё не инициализирован в момент регистрации маршрута: документ
строится при первом запросе и кэшируется.

---

## Клиент, который строит интерфейс по схеме (react-admin)

`ra-data-odata-server` и подобные провайдеры не знают о ваших сущностях заранее: при старте
они запрашивают `$metadata`, разбирают его **как XML** и строят по нему список ресурсов.
Чтобы такой клиент заработал, сервер должен дать три вещи.

**1. Схему на `$metadata` в CSDL XML.**

```ts
import { ODataMetadataMiddleware, ODataQueryMiddleware } from 'odata-v4-typeorm-improved';

// Имена наборов обязаны совпадать с сегментами маршрутов: клиент берёт EntitySet Name
// и подставляет его в URL. Набор `User` при маршруте `/api/users` увёл бы его в никуда.
const RESOURCES = { users: User, posts: Post };

const routeByEntity = new Map<unknown, string>(
  Object.entries(RESOURCES).map(([route, entity]) => [entity, route])
);

app.get('/api/$metadata', ODataMetadataMiddleware(dataSource, {
  entities: Object.values(RESOURCES),
  entitySetName: (metadata) => routeByEntity.get(metadata.target) ?? metadata.name,
}));
```

**2. Списки в конверте OData.** Провайдер читает `value` и `@odata.count`, а не голый
массив, — см. [Конверт OData в ответе](#конверт-odata-в-ответе) выше.

**3. Маршрут на каждый набор** — обычный `ODataQueryMiddleware`, обёрнутый в тот же конверт.

```ts
for (const [route, entity] of Object.entries(RESOURCES)) {
  app.get(`/api/${route}`, ODataQueryMiddleware(dataSource.getRepository(entity), {
    alias: dataSource.getMetadata(entity).name,
    maxTop: 100,
  }));
}
```

> **Что придётся дописать самостоятельно.** Библиотека компилирует query options — и только
> их. Адресация по ключу (`/api/users(1)`), служебный документ в корне сервиса, а также
> создание, изменение и удаление записей в неё не входят: это маршрутизация и запись,
> а не трансляция запроса. Провайдеру react-admin они нужны для `getOne`, `create`,
> `update` и `delete`, поэтому их обработчики пишутся руками поверх обычного репозитория
> TypeORM.
