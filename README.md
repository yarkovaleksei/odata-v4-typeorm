# odata-v4-typeorm-improved

[![NPM](https://nodei.co/npm/odata-v4-typeorm-improved.png)](https://npmjs.org/package/odata-v4-typeorm-improved)

Компилятор OData v4 query options в запросы TypeORM. Превращает `?$filter=…&$top=…&$expand=…`
из строки запроса в готовый `SelectQueryBuilder` — без ручной сборки условий.

```ts
app.get('/api/users', ODataQueryMiddleware(dataSource.getRepository(User), { alias: 'User' }));
```

```
GET /api/users?$filter=contains(name,'ali')&$select=id,name&$orderby=name asc&$top=10
```

## Содержание

- [Установка](#установка)
- [Быстрый старт](#быстрый-старт)
- [Что поддерживается](#что-поддерживается)
- [Способы использования](#способы-использования)
  - [Express: middleware](#express-middleware)
  - [Express: свой обработчик](#express-свой-обработчик)
  - [Ограничение выдачи правами пользователя](#ограничение-выдачи-правами-пользователя)
  - [NestJS](#nestjs)
  - [Без TypeORM: только компиляция в SQL](#без-typeorm-только-компиляция-в-sql)
- [Примеры OData-запросов](#примеры-odata-запросов)
- [Важные особенности](#важные-особенности)
- [Известные ограничения](#известные-ограничения)
- [Документация](#документация)
- [Для разработчиков пакета](#для-разработчиков-пакета)
- [Лицензия](#лицензия)

## Установка

```bash
npm install odata-v4-typeorm-improved
# или
yarn add odata-v4-typeorm-improved
```

`typeorm` — peer-зависимость, версия `^0.3.28`:

```bash
npm install typeorm
```

Требуется Node.js 20 или новее.

## Быстрый старт

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

app.listen(3001, () => console.log('http://localhost:3001'));
```

Проверка:

```bash
curl "http://localhost:3001/api/users?\$top=5&\$orderby=name%20asc"
```

Ответ:

```json
{
  "items": [
    { "id": 1, "name": "Alice", "email": "alice@example.com" },
    { "id": 2, "name": "Bob", "email": "bob@example.com" }
  ],
  "count": 2
}
```

## Что поддерживается

| Опция | Статус | Пример |
|---|---|---|
| `$filter` | ✅ | `$filter=name eq 'Alice' and id gt 10` |
| `$select` | ✅ | `$select=id,name` — в том числе `$select=author/name` |
| `$orderby` | ✅ | `$orderby=name desc,id asc` |
| `$top` / `$skip` | ✅ | `$top=20&$skip=40` |
| `$count` | ⚠️ | `$count=false` — **включён по умолчанию**, отступление от спецификации |
| `$expand` | ⚠️ | `$expand=posts($select=id,title)` — вложенные `$top`/`$skip` игнорируются |
| `$search` | ⚠️ | `$search=alice` — упрощённая семантика, только корневая сущность |

В `$filter` поддержаны все операторы сравнения, логика (`and` / `or` / `not` / скобки),
арифметика (`add`, `sub`, `mul`, `div`, `mod`, унарный минус), `null` → `IS NULL`,
пути по связям (`author/name`) и функции: `contains`, `startswith`, `endswith`, `tolower`,
`toupper`, `trim`, `length`, `indexof`, `substring`, `concat`, `round`, `floor`, `ceiling`,
`year` / `month` / `day` / `hour` / `minute` / `second`, `now`.

SQL для функций подбирается под вашу СУБД автоматически (`LENGTH` против `LEN`,
`EXTRACT` против `strftime` и т.д.) — диалект берётся из подключения TypeORM.

**Не поддерживаются:** `in`, лямбды `any` / `all`, `replace`, `cast`, геопространственные
функции, `$apply`, `$compute`, `$levels`, `$skiptoken`. Такой запрос не выполняется молча —
он отвергается с `ODataUnsupportedError`.

Полная матрица с проверенным поведением каждого оператора и каждой функции, включая таблицу
генерируемого SQL по диалектам: **[docs/odata-support.md](./docs/odata-support.md)**.

## Способы использования

### Express: middleware

Самый короткий путь. Обработчик сам отправляет JSON.

```ts
import { ODataQueryMiddleware } from 'odata-v4-typeorm-improved';

app.get('/api/users', ODataQueryMiddleware(dataSource.getRepository(User), {
  alias: 'User',
  logger: myLogger,   // необязательно, по умолчанию console
}));
```

### Express: свой обработчик

Даёт контроль над кодами ошибок и форматом ответа. Рекомендуется для публичного API.

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
    // Ошибка парсера OData или SQL из-за несуществующей колонки — вина клиента
    const isClientError =
      e instanceof QueryFailedError || /^Fail at \d+/.test((e as Error).message);

    logger.error('OData query failed', { query: req.query, error: e });

    return res.status(isClientError ? 400 : 500).json({
      message: isClientError ? 'Invalid OData query.' : 'Internal server error.',
    });
  }
});
```

### Ограничение выдачи правами пользователя

Передайте `SelectQueryBuilder` с уже наложенным условием — OData-фильтры добавляются
через `andWhere`, обойти ваше условие нельзя.

```ts
app.get('/api/documents', async (req, res) => {
  const qb = dataSource
    .getRepository(Document)
    .createQueryBuilder('Document')
    .where('Document.ownerId = :ownerId', { ownerId: req.user.id });

  res.json(await executeQuery(qb, req.query));
});
```

### NestJS

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
// app.module.ts
@Module({ providers: [...databaseProviders, ...userProviders] })
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(OdataUsersMiddleware).forRoutes('api/v1/odata/users');
  }
}
```

Провайдеры `DataSource` и репозитория, а также вариант через контроллер (с корректными
кодами ошибок) — в [docs/recipes.md](./docs/recipes.md#nestjs-middleware).

### Без TypeORM: только компиляция в SQL

`createFilter` и `createQuery` возвращают фрагменты SQL и параметры — к базе не обращаются.

```ts
import { createFilter, mapToObject } from 'odata-v4-typeorm-improved';

// GET /api/users?$filter=Id eq 42
const compiled = createFilter(req.query.$filter, { alias: '' });

compiled.where;                    // 'Id = :p0'
mapToObject(compiled.parameters);  // { p0: 42 }

connection.query(`SELECT * FROM users WHERE ${compiled.where}`, [42]);
```

Полный пример с `pg` и `odata-v4-server`: [src/example/sql.ts](./src/example/sql.ts).

## Примеры OData-запросов

Для сущности `User { id, name, email, posts: Post[] }`:

```bash
# Фильтрация
GET /api/users?$filter=name eq 'Alice'
GET /api/users?$filter=id gt 10 and id lt 100
GET /api/users?$filter=(name eq 'Alice' or name eq 'Bob') and id gt 1
GET /api/users?$filter=email eq null
GET /api/users?$filter=name ne 'Alice'

# Строковые функции
GET /api/users?$filter=contains(name,'ali')
GET /api/users?$filter=startswith(email,'admin')
GET /api/users?$filter=endswith(email,'.com')
GET /api/users?$filter=tolower(name) eq 'alice'

# Выборка полей и сортировка
GET /api/users?$select=id,name
GET /api/users?$orderby=name asc
GET /api/users?$orderby=name desc,id asc

# Пагинация
GET /api/users?$top=20&$skip=40
GET /api/users?$top=20&$count=false      # ответ — массив, без счётчика
GET /api/users?$top=0&$count=true        # только счётчик, без строк

# Логика и арифметика
GET /api/users?$filter=(not (name eq 'Alice')) and id gt 1
GET /api/users?$filter=id mul 2 eq 10
GET /api/users?$filter=length(name) gt 3

# Связи
GET /api/users?$expand=posts
GET /api/users?$expand=posts($select=id,title)
GET /api/users?$expand=posts($orderby=id desc)
GET /api/users?$expand=posts($expand=comments)

# Фильтр по полю связи (без одновременного $expand той же связи)
GET /api/users?$filter=posts/title eq 'Hello'

# Поиск по всем скалярным колонкам
GET /api/users?$search=alice

# Комбинация
GET /api/users?$filter=id gt 1&$select=id,name&$orderby=name asc&$top=10
```

В реальных вызовах не забывайте про URL-кодирование (`$` → `%24`, пробел → `%20`).
В оболочке `$` нужно экранировать:

```bash
curl "http://localhost:3001/api/users?\$filter=name%20eq%20'Alice'"
```

## Важные особенности

### `$count` включён по умолчанию

Отличие от спецификации OData, о которое спотыкаются первым делом.

```ts
await executeQuery(repo, {}, { alias: 'User' });
// → { items: [...], count: 42 }      ← объект, не массив

await executeQuery(repo, { $count: 'false' }, { alias: 'User' });
// → [...]                            ← массив
```

Универсальное сужение типа:

```ts
const result = await executeQuery(repo, req.query, { alias: 'User' });
const items = Array.isArray(result) ? result : result.items;
```

Учтите: со счётчиком каждый запрос делает **два** обращения к БД. Если счётчик не нужен,
`$count=false` заметно дешевле.

### `alias` не произвольный

Значение `options.alias` служит и SQL-префиксом колонок, и ключом поиска метаданных сущности.
Поэтому оно обязано совпадать с именем класса сущности или именем её таблицы:

```ts
executeQuery(repo, query, { alias: 'User' });  // ✅
executeQuery(repo, query, { alias: 'u' });     // ❌ Error: No metadata for "u" was found.
```

То же касается `SelectQueryBuilder`: привычный `createQueryBuilder('u')` не подойдёт,
нужен `createQueryBuilder('User')`.

### Неподдерживаемое отвергается, а не игнорируется

Если библиотека не может транслировать часть запроса, она бросает `ODataUnsupportedError`,
а не выполняет запрос без этой части. Это осознанное правило: молча вернуть больше данных,
чем просил клиент, опаснее явной ошибки.

```ts
import { ODataUnsupportedError } from 'odata-v4-typeorm-improved';

try {
  await executeQuery(repo, req.query, { alias: 'User' });
} catch (e) {
  if (e instanceof ODataUnsupportedError) {
    return res.status(400).json({ message: e.message, feature: e.feature });
  }

  throw e;
}
```

### Защита от SQL-инъекций

Значения из `$filter` и `$search` никогда не попадают в SQL напрямую — они уходят в
параметры запроса (`:p0`, `:p1`, …), а в строку идёт плейсхолдер. Имена полей приходят
из грамматики OData-парсера.

Чего библиотека **не** делает: не ограничивает список доступных полей и связей
(через `$select` и `$expand` клиент достанет любое поле сущности) и не ставит верхнюю границу
на `$top`. На публичном API добавьте и то, и другое — примеры в
[docs/recipes.md](./docs/recipes.md#чего-делать-не-стоит).

## Известные ограничения

Перед внедрением стоит знать. Полный разбор с воспроизведением — в
[docs/audit.md](./docs/audit.md).

**Приоритет `not` ниже, чем требует спецификация.** `odata-v4-parser` разбирает
`not (X) and Y` как `not (X and Y)`. Ставьте явные скобки:

```bash
# ❌ читается как not (X and Y)
GET /api/users?$filter=not (name eq 'Alice') and id gt 10
# ✅ явные внешние скобки
GET /api/users?$filter=(not (name eq 'Alice')) and id gt 10
```

**`alias` не может быть произвольным** — см. раздел выше.

**Не поддерживается:** `in`, лямбды `any` / `all`, `replace`, `cast`, геопространственные
функции, `$apply`, `$compute`, `$levels`, `$skiptoken`, вложенные `$top` / `$skip`
внутри `$expand`. Все эти случаи отвергаются явной ошибкой, а не выполняются частично.

**Ограничения по СУБД:** `$search` не работает при нестандартной `namingStrategy`
(snake_case) и на MySQL. Трансляция функций корректна для PostgreSQL, MySQL, SQLite
и MS SQL, но прогоном на живой БД в CI проверяется только SQLite.

## Документация

| Документ | О чём |
|---|---|
| [docs/api.md](./docs/api.md) | Справочник по всем экспортам |
| [docs/recipes.md](./docs/recipes.md) | Готовые примеры под конкретные задачи |
| [docs/odata-support.md](./docs/odata-support.md) | Матрица поддержки OData |
| [docs/architecture.md](./docs/architecture.md) | Устройство конвейера |
| [docs/development.md](./docs/development.md) | Работа над пакетом |
| [docs/audit.md](./docs/audit.md) | Аудит: дефекты, безопасность, инфраструктура |
| [docs/roadmap.md](./docs/roadmap.md) | План работ |

## Для разработчиков пакета

```bash
git clone https://github.com/yarkovaleksei/odata-v4-typeorm-improved.git
cd odata-v4-typeorm-improved
yarn install
```

### Команды

| Команда | Что делает |
|---|---|
| `yarn test:unit` | Прогон тестов Jest (SQLite в памяти, схема пересоздаётся перед каждым тестом) |
| `yarn lint` | ESLint по всем `.ts` / `.tsx` |
| `yarn lint:fix` | То же с автоисправлением |
| `yarn build` | Чистая пересборка в `build/` |
| `yarn server` | Демо-сервер из `examples/server` с автоперезапуском |
| `yarn release` | `build` + `npm publish` |
| `yarn release:beta` | `build` + `npm publish --tag beta` |

Перед коммитом — та же цепочка, что гоняет CI на Node 20/22/24:

```bash
yarn lint && yarn test:unit && yarn build
```

### Полезные вызовы

```bash
# Один тестовый файл
yarn test:unit --testPathPatterns=processSearch

# Тесты по имени
yarn test:unit -t 'должен обработать AND/OR'

# Watch-режим и покрытие
yarn test:unit --watch
yarn test:unit --coverage

# Что попадёт в npm-пакет
npm pack --dry-run

# Посмотреть, во что компилируется конкретный OData-запрос
yarn build && node -e "
const { createQuery } = require('./build/src/lib/createQuery');
const q = createQuery(\"\\\$filter=name eq 'Ann'\", { alias: 'user' });
console.log(q.where, [...q.parameters]);
"
```

Подробнее — отладка, структура проекта, как писать тесты, порядок релиза:
[docs/development.md](./docs/development.md).

## Лицензия

[MIT](./LICENSE) © yarkovaleksei
