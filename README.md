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

- [Попробовать вживую](#попробовать-вживую)
- [Установка](#установка)
- [Быстрый старт](#быстрый-старт)
- [Что поддерживается](#что-поддерживается)
- [Способы использования](#способы-использования)
  - [Express: middleware](#express-middleware)
  - [Схема сервиса: `$metadata` в XML](#схема-сервиса-metadata-в-xml)
  - [Express: свой обработчик](#express-свой-обработчик)
  - [Ограничение выдачи правами пользователя](#ограничение-выдачи-правами-пользователя)
  - [Ограничение доступных полей и размера страницы](#ограничение-доступных-полей-и-размера-страницы)
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

Требуется Node.js 20 или новее. Пакет публикуется в двух форматах — CommonJS и модули ES, —
поэтому одинаково работает и с `require`, и с `import`.

## Попробовать вживую

В репозитории есть демо-сервер с **интерактивным конструктором запросов**: собираете
запрос полями формы, видите получившийся URL и сразу ответ сервера.

Страница читает схему сервиса и строит по ней всё остальное: список сущностей, подсказки
с именами полей и связей под `$select` и `$expand` и готовые примеры — по типам полей
и реальным значениям выбранной сущности, так что каждый пример возвращает непустой ответ.

```bash
yarn install
yarn server
```

Затем откройте <http://localhost:3001/>. Ничего поднимать не нужно — демо работает
на SQLite, база создаётся и наполняется при старте.

Там же отдаётся схема сервиса: <http://localhost:3001/api/$metadata> — готовый документ
CSDL XML, который можно скормить клиенту OData как есть.

Там же лежит коллекция Postman на 62 запроса: [examples/postman/](./examples/postman/).

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

// alias задаёт SQL-префикс колонок и имя, под которым сущность попадёт в запрос
app.get('/api/users', ODataQueryMiddleware(dataSource.getRepository(User), { alias: 'User' }));

app.listen(3001, () => console.log('http://localhost:3001'));
```

Проверка:

```bash
curl "http://localhost:3001/api/users?\$top=5&\$orderby=name%20asc"
```

Ответ:

```json
[
  { "id": 1, "name": "Alice", "email": "alice@example.com" },
  { "id": 2, "name": "Bob", "email": "bob@example.com" }
]
```

Нужно ещё и общее число строк — добавьте `$count=true`:

```bash
curl "http://localhost:3001/api/users?\$top=5&\$orderby=name%20asc&\$count=true"
```

```json
{
  "items": [
    { "id": 1, "name": "Alice", "email": "alice@example.com" },
    { "id": 2, "name": "Bob", "email": "bob@example.com" }
  ],
  "count": 42
}
```

## Что поддерживается

| Опция | Статус | Пример |
|---|---|---|
| `$filter` | ✅ | `$filter=name eq 'Alice' and posts/any(p: p/title eq 'x')` |
| `$select` | ✅ | `$select=id,name` — в том числе `$select=author/name` |
| `$orderby` | ✅ | `$orderby=name desc,id asc` |
| `$top` / `$skip` | ✅ | `$top=20&$skip=40` |
| `$count` | ✅ | `$count=true` — по умолчанию выключен, ответ тогда обычный массив |
| `$expand` | ✅ | `$expand=posts($select=id,title;$top=2)` — вложенная страница вырезается в SQL оконной функцией |
| `$search` | ✅ | `$search=(ada OR grace) NOT "computer science"` — грамматика OData целиком |

В `$filter` поддержаны все операторы сравнения, логика (`and` / `or` / `not` / скобки),
оператор `in`, лямбды `any` / `all` по связям, арифметика (`add`, `sub`, `mul`, `div`, `mod`,
унарный минус), `null` → `IS NULL`,
пути по связям (`author/name`) и функции: `contains`, `startswith`, `endswith`, `tolower`,
`toupper`, `trim`, `length`, `indexof`, `substring`, `concat`, `round`, `floor`, `ceiling`,
`year` / `month` / `day` / `hour` / `minute` / `second`, `date`, `time`, `now`.

SQL для функций подбирается под вашу СУБД автоматически (`LENGTH` против `LEN`,
`EXTRACT` против `strftime` и т.д.) — диалект берётся из подключения TypeORM.

Помимо запросов библиотека отдаёт **схему сервиса** — документ `$metadata` в CSDL XML,
тот самый, который разбирают `ra-data-odata-server`, `@odata/client` и Excel:
[Схема сервиса](#схема-сервиса-metadata-в-xml).

**Не поддерживаются:** `replace`, `cast`, `isof`,
`mindatetime` / `maxdatetime`, `totalseconds`, геопространственные функции, `$apply`,
`$compute`, `$levels`, `$skiptoken`. Такой запрос не выполняется молча — он отвергается
с `ODataUnsupportedError`.

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

### Схема сервиса: `$metadata` в XML

Клиенты, которые строят интерфейс по схеме, а не по документации, первым делом запрашивают
`$metadata` и разбирают ответ **как XML**: `ra-data-odata-server` (react-admin),
`@odata/client`, Olingo, Excel. Спецификация OData v4 допускает и JSON-представление модели,
но обязательное — XML, и на JSON эти клиенты не рассчитаны.

```ts
import { ODataMetadataMiddleware, ODataQueryMiddleware } from 'odata-v4-typeorm-improved';

app.get('/api/$metadata', ODataMetadataMiddleware(dataSource, {
  namespace: 'Shop',
  // Только опубликованные сущности: $metadata раскрывает схему БД целиком.
  entities: [User, Post],
  // Имя набора = сегмент маршрута, иначе клиент пойдёт по несуществующему адресу.
  entitySetName: (metadata) => (metadata.name === 'User' ? 'users' : 'posts'),
}));

app.get('/api/users', ODataQueryMiddleware(dataSource.getRepository(User), { alias: 'User' }));
app.get('/api/posts', ODataQueryMiddleware(dataSource.getRepository(Post), { alias: 'Post' }));
```

```
GET /api/$metadata
Content-Type: application/xml
OData-Version: 4.0
```

```xml
<?xml version="1.0" encoding="UTF-8"?>
<edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx" Version="4.0">
  <edmx:DataServices>
    <Schema xmlns="http://docs.oasis-open.org/odata/ns/edm" Namespace="Shop">
      <EntityType Name="User">
        <Key>
          <PropertyRef Name="id"/>
        </Key>
        <Property Name="id" Type="Edm.Int32" Nullable="false"/>
        <Property Name="name" Type="Edm.String" Nullable="false"/>
        <NavigationProperty Name="posts" Type="Collection(Shop.Post)" Partner="user"/>
      </EntityType>
      ...
      <EntityContainer Name="Container">
        <EntitySet Name="users" EntityType="Shop.User">
          <NavigationPropertyBinding Path="posts" Target="posts"/>
        </EntitySet>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>
```

Нужна только строка, без HTTP (NestJS, Fastify, запись схемы в файл) — есть
`createMetadataDocument(dataSource, options)`.

Документ описывает ровно то, что библиотека реально отдаёт: колонки `select: false`,
поля встроенных сущностей и колонки внешних ключей в него не попадают. Полный перечень
исключений и все опции — в [docs/api.md](./docs/api.md#createmetadatadocument).

### Express: свой обработчик

Даёт контроль над форматом ответа.

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

    if (isODataClientError(e)) {
      return res.status(400).json({ message: e.message });
    }

    return res.status(500).json({ message: 'Internal server error.' });
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
    .createQueryBuilder('d')
    .where('d.ownerId = :ownerId', { ownerId: req.user.id });

  res.json(await executeQuery(qb, req.query));
});
```

### Ограничение доступных полей и размера страницы

Для публичного API задавайте потолок страницы и белые списки — иначе клиент вправе
вытащить любое поле сущности, пройти по любой связи и запросить таблицу целиком.

```ts
const data = await executeQuery(dataSource.getRepository(User), req.query, {
  alias: 'User',
  maxTop: 100,                                    // $top больше — усечётся до 100
  allowedFields: ['id', 'name', 'posts/title'],   // полные пути от корня
  allowedExpands: ['posts'],                      // имена связей на каждом уровне
});
```

`allowedFields` покрывает не только `$select`, но и `$filter` с `$orderby`, включая поля
внутри функций: `$filter=contains(passwordHash,'x')` будет отвергнут.

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

Библиотека отдаёт **именованные** плейсхолдеры (`:p0`), а `pg` ждёт **позиционные** (`$1`) —
переходник и полный пример с `from()`: [docs/recipes.md](./docs/recipes.md#без-typeorm-только-компиляция-в-sql).

## Примеры OData-запросов

Готовая шпаргалка по всем поддержанным конструкциям — от фильтров и функций до лямбд
и вложенной пагинации: [docs/recipes.md](./docs/recipes.md#примеры-odata-запросов).

В реальных вызовах не забывайте про URL-кодирование (`$` → `%24`, пробел → `%20`).
В оболочке `$` нужно экранировать:

```bash
curl "http://localhost:3001/api/users?\$filter=name%20eq%20'Alice'"
```

## Важные особенности

### Форма ответа зависит от `$count`

`$count` управляет тем, что вернётся: массив или объект со счётчиком. По умолчанию он
выключен — как и требует OData v4 (раздел 11.2.5.5).

```ts
await executeQuery(repo, {}, { alias: 'User' });
// → [...]                            ← массив, одно обращение к БД

await executeQuery(repo, { $count: 'true' }, { alias: 'User' });
// → { items: [...], count: 42 }      ← объект; count — число строк по фильтрам,
//                                       без учёта $top и $skip
```

Универсальное сужение типа:

```ts
const result = await executeQuery(repo, req.query, { alias: 'User' });
const items = Array.isArray(result) ? result : result.items;
```

Учтите: со счётчиком запрос делает **два** обращения к БД (`getManyAndCount`), поэтому
включайте `$count` только там, где счётчик действительно нужен, — например для пагинации.

> **Изменение в 2.0.0.** До этой версии `$count` был включён по умолчанию, и ответом на
> любой запрос был объект `{ items, count }`. Если вы обновляетесь с 1.x и полагались на
> эту форму, добавьте `$count=true` в запрос либо разворачивайте результат через
> `Array.isArray`, как в примере выше.

### Про `alias`

`options.alias` — это SQL-префикс колонок. Для `Repository` его нужно задавать (им создаётся
построитель); для готового `SelectQueryBuilder` — либо не задавать вовсе, либо указать
его же корневой алиас.

```ts
// Repository: алиас задаём
executeQuery(repository, query, { alias: 'User' });

// QueryBuilder: алиас берётся у него самого, любой
executeQuery(dataSource.getRepository(User).createQueryBuilder('u'), query);

// ❌ алиас, разошедшийся с алиасом построителя, даст ошибку СУБД
executeQuery(dataSource.getRepository(User).createQueryBuilder('u'), query, { alias: 'x' });
```

Метаданные сущности берутся из самого построителя, поэтому совпадать с именем класса
алиасу больше не нужно — привычный TypeORM-стиль `createQueryBuilder('u')` работает.

### Неподдерживаемое отвергается, а не игнорируется

Если библиотека не может транслировать часть запроса, она бросает ошибку, а не выполняет
запрос без этой части. Это осознанное правило: молча вернуть больше данных, чем просил
клиент, опаснее явной ошибки.

Все ошибки библиотеки несут признак `isClientError`, по которому HTTP-слой отличает
`400` от `500` без разбора текста сообщения:

| Класс | Когда |
|---|---|
| `ODataParseError` | выражение не разобрал парсер |
| `ODataUnsupportedError` | конструкция вне поддерживаемого подмножества |
| `ODataInvalidQueryError` | недопустимое значение параметра, поле вне белого списка |

```ts
import { isODataClientError } from 'odata-v4-typeorm-improved';

try {
  await executeQuery(repo, req.query, { alias: 'User' });
} catch (e) {
  if (isODataClientError(e)) {
    return res.status(400).json({ message: e.message });
  }

  throw e;
}
```

`ODataQueryMiddleware` делает это сам: клиентские ошибки → `400`, остальное → `500`,
текст исходной ошибки уходит только в лог.

### Защита от SQL-инъекций

Значения из `$filter` и `$search` никогда не попадают в SQL напрямую — они уходят в
параметры запроса (`:p0`, `:p1`, …), а в строку идёт плейсхолдер. Имена полей приходят
из грамматики OData-парсера.

Колонки, помеченные `@Column({ select: false })`, не покидают сервер: они исключены
из выборки по умолчанию, а обращение к ним через `$select`, `$filter` или `$orderby`
отвергается — иначе фильтр работал бы оракулом для подбора значения.

Ограничение остальных полей и размера страницы **не включено по умолчанию** — задайте
`allowedFields`, `allowedExpands` и `maxTop`, см. раздел выше.

## Известные ограничения

Перед внедрением стоит знать. Полный разбор с воспроизведением — в
[docs/audit.md](./docs/audit.md).

**Не поддерживается:** `replace`, `cast`, `isof`, геопространственные функции, `$apply`,
`$compute`, `$levels`, `$skiptoken`. Все эти случаи отвергаются явной ошибкой, а не
выполняются частично.

**Лямбды `any` / `all` не читают путь через связь внутри тела.** `books/any(b: b/pages gt 100)`
работает, `books/any(b: b/author/name eq 'Ada')` — нет: это потребовало бы ещё одного
соединения внутри подзапроса. Тот же смысл выражается вложенной лямбдой, которая поддержана.

**`$search` по умолчанию ищет по всем колонкам корня.** Для публичного API задавайте
`searchFields`: иначе клиент перебором строки поиска выясняет содержимое полей, которых
не видит в ответе, и каждый запрос сканирует таблицу целиком.

**Вложенные `$top` / `$skip` внутри `$expand`** выполняются в SQL: страницу каждой связи
вырезает оконная функция в условии соединения. На MySQL и на незнакомых драйверах срез
по-прежнему делается после запроса — почему именно так, написано в
[docs/odata-support.md](./docs/odata-support.md#вложенные-top-и-skip).

**Белые списки выключены по умолчанию.** Без `allowedFields` / `allowedExpands` клиент
видит любое поле сущности и любую связь — см. раздел выше.

**Расхождения между СУБД.** Матрица прогоняется в CI на SQLite, PostgreSQL и MySQL;
для MS SQL проверяется только генерируемый SQL. Найденные различия — свойства самих баз,
не дефекты трансляции: `div` над целыми в MySQL не целочисленное, округление ровно `4.5`
у SQLite и PostgreSQL разное. Подробности — в
[docs/odata-support.md](./docs/odata-support.md#совместимость-с-субд).

## Документация

| Документ | О чём |
|---|---|
| [docs/api.md](./docs/api.md) | Справочник по всем экспортам |
| [docs/recipes.md](./docs/recipes.md) | Готовые примеры под конкретные задачи |
| [docs/odata-support.md](./docs/odata-support.md) | Матрица поддержки OData |
| [docs/architecture.md](./docs/architecture.md) | Устройство конвейера |
| [CHANGELOG.md](./CHANGELOG.md) | Что менялось между версиями, включая ломающие изменения |

Эти четыре документа плюс `CHANGELOG.md` входят в npm-пакет. Материалы для тех, кто
дорабатывает саму библиотеку, живут только в репозитории: [development.md](./docs/development.md)
(команды, тесты, релиз), [audit.md](./docs/audit.md) (журнал аудита с воспроизведением
каждого дефекта), [roadmap.md](./docs/roadmap.md) (журнал работ) и
[CONTRIBUTING.md](./CONTRIBUTING.md).

## Для разработчиков пакета

```bash
git clone https://github.com/yarkovaleksei/odata-v4-typeorm-improved.git
cd odata-v4-typeorm-improved
```

Дальше — на выбор. **В Docker** окружение одинаково у всех: версия Node, системные
библиотеки для нативных модулей и версии СУБД зафиксированы в образе. Нужен только Docker
с плагином Compose:

```bash
yarn docker:test        # lint + формат + документация + тесты + сборка
yarn docker:test:all    # матрица OData на SQLite, PostgreSQL и MySQL
yarn docker:down        # погасить всё
```

Зависимости ставятся при старте контейнера, а не при сборке образа — пересобирать его
после правки `package.json` не нужно.

**Локально** цикл правка-проверка быстрее:

```bash
yarn install
yarn verify                  # lint + формат + документация + тесты + сборка + загрузка пакета
yarn db:up && yarn test:all  # матрица на трёх СУБД, базы из compose
```

### Команды

| Команда | Что делает |
|---|---|
| `yarn verify` | lint + формат + документация + тесты + сборка + загрузка пакета |
| `yarn test:unit` | Прогон тестов Jest на SQLite в памяти |
| `yarn test:all` | Тот же набор тестов на всех трёх СУБД |
| `yarn test:coverage` | Тесты с измерением покрытия и проверкой порогов |
| `yarn db:up` / `yarn db:down` | Поднять и погасить PostgreSQL и MySQL для прогона с хоста |
| `yarn lint` / `yarn lint:fix` | ESLint, с автоисправлением и без |
| `yarn format` / `yarn format:check` | Prettier, с записью изменений и без |
| `yarn docs:check` | Ссылки, якоря и примеры кода в документации |
| `yarn build` | Пересборка обоих форматов: CommonJS и модули ES |
| `yarn docker:test` | `yarn verify` внутри контейнера |
| `yarn docker:test:all` | Матрица на трёх СУБД внутри контейнера |
| `yarn docker:sh` | Оболочка внутри контейнера |
| `yarn docker:down` | Погасить контейнеры и удалить тома |
| `yarn server` | Демо-сервер и конструктор запросов на <http://localhost:3001/> |
| `yarn server:typecheck` | Проверка типов демо-сервера |
| `yarn release` | `build` + `npm publish` |
| `yarn release:beta` | `build` + `npm publish --tag beta` |

Перед коммитом — та же цепочка, что гоняет CI на Node 20/22/24:

```bash
yarn verify          # либо yarn docker:test
```

### Полезные вызовы

```bash
# Один тестовый файл
yarn test:unit --testPathPatterns=processSearch

# Тесты по имени
yarn test:unit -t 'должен обработать AND/OR'

# Watch-режим и покрытие
yarn test:unit --watch
yarn test:coverage

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
