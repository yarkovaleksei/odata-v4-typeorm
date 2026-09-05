# Рецепты

Рабочие примеры под конкретные задачи. Справочник сигнатур — в [api.md](./api.md),
границы возможностей — в [odata-support.md](./odata-support.md).

---

## Express: минимальный эндпоинт

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

---

## Express: свой обработчик (рекомендуется для публичного API)

`ODataQueryMiddleware` отдаёт `500` на клиентские ошибки и раскрывает текст ошибки СУБД.
Для публичного API лучше вызывать `executeQuery` напрямую.

```ts
import { executeQuery } from 'odata-v4-typeorm-improved';
import { QueryFailedError } from 'typeorm';

app.get('/api/users', async (req, res) => {
  try {
    const result = await executeQuery(dataSource.getRepository(User), req.query, {
      alias: 'User',
    });

    return res.json(result);
  } catch (e) {
    // Ошибка парсера OData либо ошибка SQL из-за несуществующей колонки — вина клиента
    const isClientError =
      e instanceof QueryFailedError || /^Fail at \d+/.test((e as Error).message);

    logger.error('OData query failed', { query: req.query, error: e });

    return res.status(isClientError ? 400 : 500).json({
      message: isClientError ? 'Invalid OData query.' : 'Internal server error.',
    });
  }
});
```

Обратите внимание: наружу не уходит `e.message` — он остаётся в логе.

---

## Ограничение выдачи правами пользователя

Передайте `SelectQueryBuilder` с уже наложенным условием. OData-фильтры добавляются
через `andWhere`, поэтому ваше условие обойти нельзя.

```ts
app.get('/api/documents', async (req, res) => {
  const qb = dataSource
    .getRepository(Document)
    .createQueryBuilder('Document')
    .where('Document.ownerId = :ownerId', { ownerId: req.user.id });

  const result = await executeQuery(qb, req.query);

  res.json(result);
});
```

Для мультиарендности — то же самое с `tenantId`.

> `ODataQueryMiddleware` для этого не подходит: репозиторий захватывается замыканием
> один раз при регистрации маршрута и не видит текущий запрос.

---

## Форма ответа: массив или `{ items, count }`

`$count` **включён по умолчанию**, поэтому базовая форма ответа — объект.

```ts
const result = await executeQuery(repo, req.query, { alias: 'User' });

// Универсальное сужение типа
const items = Array.isArray(result) ? result : result.items;
const total = Array.isArray(result) ? result.length : result.count;
```

Всегда возвращать массив:

```ts
const result = await executeQuery(repo, { ...req.query, $count: 'false' }, { alias: 'User' });
// result: User[]
```

Получить только счётчик, без строк — `$top=0`:

```ts
const result = await executeQuery(repo, { $top: '0', $count: 'true' }, { alias: 'User' });
// { items: [], count: 42 }
```

Всегда возвращать счётчик — ничего делать не нужно, это поведение по умолчанию.

> Каждый запрос со счётчиком делает **два** обращения к БД. Если счётчик не нужен,
> `$count=false` заметно дешевле.

---

## Ответ в формате OData

Библиотека отдаёт «сырой» результат. Обёртка в конверт OData — на стороне приложения:

```ts
app.get('/api/users', async (req, res) => {
  const result = await executeQuery(dataSource.getRepository(User), req.query, { alias: 'User' });

  const items = Array.isArray(result) ? result : result.items;
  const count = Array.isArray(result) ? undefined : result.count;

  res.json({
    '@odata.context': `${req.protocol}://${req.get('host')}/api/$metadata#Users`,
    ...(count !== undefined && { '@odata.count': count }),
    value: items,
  });
});
```

---

## NestJS: middleware

```ts
// odata-users.middleware.ts
import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { ODataQueryMiddleware } from 'odata-v4-typeorm-improved';
import { Repository } from 'typeorm';

import { UserEntity } from '../entities/user.entity';

@Injectable()
export class OdataUsersMiddleware implements NestMiddleware {
  constructor(
    @Inject('USERS_REPOSITORY') private readonly usersRepository: Repository<UserEntity>
  ) {}

  use(req: Request, res: Response, next: NextFunction) {
    return ODataQueryMiddleware(this.usersRepository, { alias: 'UserEntity' })(req, res, next);
  }
}
```

```ts
// database.providers.ts
import { DataSource } from 'typeorm';

import { UserEntity } from '../entities/user.entity';

export const databaseProviders = [
  {
    provide: 'DATA_SOURCE',
    useFactory: async () => {
      const dataSource = new DataSource({
        type: 'postgres',
        host: 'localhost',
        port: 5432,
        username: 'postgres',
        password: 'postgres',
        database: 'app',
        entities: [UserEntity],
      });

      return dataSource.initialize();
    },
  },
];
```

```ts
// user.providers.ts
import { DataSource } from 'typeorm';

import { UserEntity } from '../entities/user.entity';

export const userProviders = [
  {
    provide: 'USERS_REPOSITORY',
    useFactory: (dataSource: DataSource) => dataSource.getRepository(UserEntity),
    inject: ['DATA_SOURCE'],
  },
];
```

```ts
// app.module.ts
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';

import { databaseProviders } from './db/database.providers';
import { OdataUsersMiddleware } from './middlewares/odata-users.middleware';
import { userProviders } from './providers/user.providers';

@Module({
  providers: [...databaseProviders, ...userProviders],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(OdataUsersMiddleware).forRoutes('api/v1/odata/users');
  }
}
```

---

## NestJS: контроллер вместо middleware

Даёт контроль над кодами ошибок и ограничениями доступа.

```ts
import { BadRequestException, Controller, Get, Query, Req } from '@nestjs/common';
import { executeQuery, type QueryParams } from 'odata-v4-typeorm-improved';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';

@Controller('api/users')
export class UsersController {
  constructor(
    @InjectRepository(UserEntity) private readonly repository: Repository<UserEntity>
  ) {}

  @Get()
  async find(@Query() query: QueryParams, @Req() req: RequestWithUser) {
    const qb = this.repository
      .createQueryBuilder('UserEntity')
      .where('UserEntity.tenantId = :tenantId', { tenantId: req.user.tenantId });

    try {
      return await executeQuery(qb, query);
    } catch (e) {
      if (e instanceof QueryFailedError || /^Fail at \d+/.test((e as Error).message)) {
        throw new BadRequestException('Invalid OData query.');
      }

      throw e;
    }
  }
}
```

---

## Без TypeORM: только компиляция в SQL

`createFilter` возвращает фрагмент `WHERE` и параметры — подставьте их в собственный запрос.

```ts
import { createFilter, mapToObject } from 'odata-v4-typeorm-improved';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

app.get('/api/users', async (req, res) => {
  // GET /api/users?$filter=Id eq 42
  const compiled = createFilter(req.query.$filter as string, { alias: '' });

  const params = mapToObject(compiled.parameters);

  // compiled.where: "Id = :p0", params: { p0: 42 }
  // pg использует позиционные $1 — при желании перепишите плейсхолдеры
  const result = await pool.query(`SELECT * FROM users WHERE ${compiled.where}`, [params.p0]);

  res.json({ value: result.rows });
});
```

Полный пример с `odata-v4-server`: [src/example/sql.ts](../src/example/sql.ts).

---

## Компиляция полного запроса без выполнения

Полезно для отладки и для собственного слоя выполнения.

```ts
import { createQuery, mapToObject } from 'odata-v4-typeorm-improved';

const compiled = createQuery("$filter=name eq 'Ann' and age gt 18&$orderby=name desc", {
  alias: 'user',
});

console.log(compiled.where);                    // user.name = :p0 AND user.age > :p1
console.log(compiled.orderby);                  // user.name DESC
console.log(mapToObject(compiled.parameters));  // { p0: 'Ann', p1: 18 }
console.log(compiled.includes.length);          // 0
```

Подстановка в свой построитель:

```ts
queryBuilder
  .andWhere(compiled.where)
  .setParameters(mapToObject(compiled.parameters));
```

---

## Примеры OData-запросов

Для сущности `User { id, name, email, posts: Post[] }`:

```bash
# Фильтрация
GET /api/users?$filter=name eq 'Alice'
GET /api/users?$filter=id gt 10 and id lt 100
GET /api/users?$filter=(name eq 'Alice' or name eq 'Bob') and id gt 1
GET /api/users?$filter=email eq null

# Поиск по подстроке
GET /api/users?$filter=contains(name,'ali')
GET /api/users?$filter=startswith(email,'admin')
GET /api/users?$filter=tolower(name) eq 'alice'

# Выборка полей
GET /api/users?$select=id,name

# Сортировка
GET /api/users?$orderby=name asc
GET /api/users?$orderby=name desc,id asc

# Пагинация
GET /api/users?$top=20&$skip=40
GET /api/users?$top=20&$count=false      # без счётчика, ответ — массив

# Связи
GET /api/users?$expand=posts
GET /api/users?$expand=posts($select=id,title)
GET /api/users?$expand=posts($orderby=id desc)
GET /api/users?$expand=posts($expand=comments)

# Фильтр по полю связи (БЕЗ одновременного $expand той же связи)
GET /api/users?$filter=posts/title eq 'Hello'

# Полнотекстовый поиск по всем скалярным колонкам
GET /api/users?$search=alice

# Комбинация
GET /api/users?$filter=id gt 1&$select=id,name&$orderby=name asc&$top=10&$skip=0
```

Не забудьте про URL-кодирование: `$` → `%24`, пробел → `%20`, `'` → `%27`.
`curl` в оболочке требует экранирования `$`:

```bash
curl "http://localhost:3001/api/users?\$filter=name%20eq%20'Alice'"
```

---

## Чего делать не стоит

**Ставьте явные скобки вокруг `not`.** Парсер разбирает `not (X) and Y` как `not (X and Y)` —
приоритет ниже, чем требует спецификация:

```bash
# ❌ читается как not (X and Y) — вернёт не то, что вы ожидаете
GET /api/users?$filter=not (name eq 'Alice') and id gt 10

# ✅ явные внешние скобки задают нужную группировку
GET /api/users?$filter=(not (name eq 'Alice')) and id gt 10

# ✅ либо поставьте not последним
GET /api/users?$filter=id gt 10 and not (name eq 'Alice')
```

**Не рассчитывайте на `in` и лямбды `any` / `all`** — их не разбирает парсер, запрос будет
отвергнут с `ODataUnsupportedError`:

```bash
# ❌ ODataUnsupportedError
GET /api/users?$filter=posts/any(p: p/title eq 'x')

# ✅ фильтр по пути связи — семантика близка к any
GET /api/users?$filter=posts/title eq 'x'

# ❌ Unexpected character
GET /api/users?$filter=id in (1,2,3)

# ✅ разверните в or
GET /api/users?$filter=id eq 1 or id eq 2 or id eq 3
```

**Не оставляйте `$top` неограниченным на публичном API.** Верхней границы у библиотеки нет —
ставьте свою:

```ts
const MAX_TOP = 100;
const top = Math.min(Number(req.query.$top) || 25, MAX_TOP);

const result = await executeQuery(repo, { ...req.query, $top: String(top) }, { alias: 'User' });
```

**Не открывайте сущность целиком, если в ней есть чувствительные поля.** `$select` и `$expand`
не проверяются по белому списку — клиент достанет любое поле и пройдёт по любой связи.
Используйте отдельные view-сущности либо `SelectQueryBuilder` с явным `select`.
