# Рецепты

Рабочие примеры под конкретные задачи. Здесь — то, что не зависит от веб-фреймворка:
опции запроса, форма ответа, поиск, фильтры, компиляция без TypeORM.

Привязка к фреймворку вынесена отдельно:

| Документ | О чём |
|---|---|
| [recipes-express.md](./recipes-express.md) | Express: маршруты, готовые middleware, обработка ошибок, `$metadata` |
| [recipes-nestjs.md](./recipes-nestjs.md) | NestJS: контроллеры, провайдеры, фильтр исключений, интерцептор конверта |

Справочник сигнатур — в [api.md](./api.md), границы возможностей —
в [odata-support.md](./odata-support.md).

---

## Ограничение доступных полей, связей и размера страницы

```ts
const result = await executeQuery(dataSource.getRepository(User), query, {
  alias: 'User',
  // $top больше — усекается до 100; отрицательный отвергается как 400
  maxTop: 100,
  // полные пути от корня; покрывает $select, $filter и $orderby
  allowedFields: ['id', 'name', 'email', 'posts/id', 'posts/title'],
  // имена связей, проверяются на каждом уровне вложенности
  allowedExpands: ['posts'],
});
```

Запрос вне списка отвергается с `ODataInvalidQueryError` (клиентская ошибка → `400`):

```bash
GET /api/users?$select=passwordHash            # → 400
GET /api/users?$filter=contains(passwordHash,'a')  # → 400, поле внутри функции тоже видно
GET /api/users?$expand=sessions                # → 400
```

---

## Ограничение выдачи правами пользователя

Передайте `SelectQueryBuilder` с уже наложенным условием. OData-фильтры добавляются
через `andWhere`, поэтому ваше условие обойти нельзя.

```ts
import { executeQuery, type QueryParams } from 'odata-v4-typeorm-improved';

function findDocuments(query: QueryParams, ownerId: number) {
  const qb = dataSource
    .getRepository(Document)
    .createQueryBuilder('Document')
    .where('Document.ownerId = :ownerId', { ownerId });

  return executeQuery(qb, query);
}
```

Для мультиарендности — то же самое с `tenantId`.

> Готовые middleware (`ODataQueryMiddleware`) для этого не подходят: репозиторий
> захватывается замыканием один раз при регистрации маршрута и не видит текущий запрос.

Как подключить такую функцию к маршруту:
[Express](./recipes-express.md#права-пользователя-и-мультиарендность),
[NestJS](./recipes-nestjs.md#права-пользователя-и-мультиарендность).

---

## Форма ответа: массив или объект со счётчиком

`$count` по умолчанию выключен, поэтому базовая форма ответа — массив. Объект со
счётчиком возвращается только на явный `$count=true`.

```ts
const result = await executeQuery(repo, query, { alias: 'User' });

// Универсальное сужение типа
const items = Array.isArray(result) ? result : result.items;
const total = Array.isArray(result) ? result.length : result.count;
```

Всегда возвращать массив — запретить клиенту менять форму ответа:

```ts
const result = await executeQuery(repo, { ...query, $count: 'false' }, { alias: 'User' });
// result: User[]
```

Всегда возвращать счётчик — независимо от того, что прислал клиент:

```ts
const result = await executeQuery(repo, { ...query, $count: 'true' }, { alias: 'User' });
// result: { items: User[]; count: number }
```

Получить только счётчик, без строк — `$top=0`:

```ts
const result = await executeQuery(repo, { $top: '0', $count: 'true' }, { alias: 'User' });
// { items: [], count: 42 }
```

> Запрос со счётчиком делает **два** обращения к БД (`getManyAndCount`), поэтому включать
> `$count` стоит только там, где счётчик действительно нужен.

---

## Ответ в формате OData

Библиотека отдаёт «сырой» результат. Обёртка в конверт OData — на стороне приложения.
Она не зависит от фреймворка: нужна только форма результата и адрес сервиса.

```ts
import type { GetManyResponse } from 'odata-v4-typeorm-improved';
import type { ObjectLiteral } from 'typeorm';

export function toODataEnvelope<T extends ObjectLiteral>(
  result: T[] | GetManyResponse<T>,
  context: string
) {
  const items = Array.isArray(result) ? result : result.items;
  const count = Array.isArray(result) ? undefined : result.count;

  return {
    '@odata.context': context,
    // @odata.count добавляется только на $count=true — иначе клиент решит, что счётчик равен нулю
    ...(count !== undefined && { '@odata.count': count }),
    value: items,
  };
}
```

`context` — абсолютный адрес схемы с якорем набора: `https://host/api/$metadata#Users`.
Его собирают из текущего запроса; примеры —
[Express](./recipes-express.md#конверт-odata-в-ответе),
[NestJS](./recipes-nestjs.md#конверт-odata-через-интерцептор).

---

## Настройка `$search`

По умолчанию `$search` ищет по **всем скалярным колонкам корня**: текстовым по подстроке,
числовым по точному равенству. Для публичного API это почти всегда не то, что нужно, —
перечислите поля явно:

```ts
const result = await executeQuery(dataSource.getRepository(Book), query, {
  alias: 'Book',
  // пути от корня; можно идти через связи
  searchFields: ['title', 'author/name'],
});
```

Поле связи (`'author/name'`) компилируется в `EXISTS`, поэтому число корневых строк
не меняется и `$top` продолжает означать «столько-то книг».

Выражение поиска разбирается по грамматике OData целиком — скобки, `AND`, `OR`, `NOT`
и фразы в кавычках:

```bash
GET /api/books?$search=ada
GET /api/books?$search=ada OR hopper
GET /api/books?$search="grace hopper" NOT compiler
GET /api/books?$search=(ada OR grace) AND algorithm
```

### Полнотекстовый режим

`'like'` (по умолчанию) находит середину слова, но не пользуется индексами — каждый запрос
сканирует таблицу. `'fulltext'` переключает сравнение на полнотекстовый поиск СУБД: ищет
слова целиком, зато опирается на индекс.

```ts
const result = await executeQuery(dataSource.getRepository(Book), query, {
  alias: 'Book',
  searchFields: ['title', 'description'],
  searchMode: 'fulltext',
  // словарь словоформ PostgreSQL: с 'simple' найдётся только точное слово,
  // с 'russian' — все его формы. Должен совпадать с языком в индексе.
  searchLanguage: 'russian',
});
```

Индекс под этот режим:

```sql
-- PostgreSQL: язык обязан совпадать с searchLanguage, иначе индекс не используется
CREATE INDEX book_title_fts ON book USING GIN (to_tsvector('russian', title));

-- MySQL: без индекса СУБД просто отвергнет запрос
ALTER TABLE book ADD FULLTEXT INDEX book_title_fts (title, description);
```

> На SQLite и MS SQL режим молча остаётся `'like'`: там полнотекстовый поиск требует
> отдельной виртуальной таблицы или каталога. Один и тот же код работает на SQLite
> в разработке и на PostgreSQL в продакшене — падать на этом различии он не должен.

---

## Фильтры по коллекциям: `any` и `all`

Лямбда-операторы отвечают на вопрос «есть ли в коллекции запись, для которой…», не размножая
корневые строки:

```bash
# у автора есть хотя бы одна книга длиннее 400 страниц
GET /api/authors?$filter=books/any(b: b/pages gt 400)

# все книги автора длиннее 200 страниц (для автора без книг — истина)
GET /api/authors?$filter=books/all(b: b/pages gt 200)

# книги вообще есть
GET /api/authors?$filter=books/any()

# путь до коллекции может быть составным, а лямбды — вкладываться
GET /api/authors?$filter=books/reviews/any(r: r/score eq 5)
GET /api/authors?$filter=books/any(b: b/reviews/any(r: r/score eq 5))

# внутри тела доступен и внешний уровень: имя без переменной относится к корню
GET /api/authors?$filter=books/any(b: b/title eq name)
```

Оба разворачиваются в `EXISTS` / `NOT EXISTS`, а не в соединение, — поэтому их можно
свободно сочетать с `$top` и `$count`:

```sql
-- books/any(b: b/pages gt 400)
EXISTS (SELECT 1 FROM "book" "Author_books_b"
         WHERE "Author_books_b"."author_id" = "Author"."id" AND ("Author_books_b"."pages" > :p0))
```

Белый список `allowedExpands` видит связи, пройденные лямбдой, хотя JOIN они не создают:

```ts
// $filter=books/any(...) пройдёт, $filter=sessions/any(...) — нет
await executeQuery(repo, query, { alias: 'Author', allowedExpands: ['books'] });
```

> Лямбдам нужны метаданные сущности, чтобы назвать таблицу подзапроса. `executeQuery`
> подставляет их сам; при прямом вызове `createFilter` без `resolveRelation` лямбда
> отвергается `ODataUnsupportedError`.

---

## Вложенная пагинация внутри `$expand`

`$top` и `$skip` внутри `$expand` ограничивают коллекцию **каждого** родителя отдельно:

```bash
# по три последних поста на каждого пользователя
GET /api/users?$expand=posts($orderby=createdAt desc;$top=3)

# со второго по четвёртый
GET /api/users?$expand=posts($orderby=id;$top=3;$skip=1)
```

Обычным `LIMIT` это не выражается: в запросе с `LEFT JOIN` он действует на весь плоский
результат, а не на группу строк одного родителя. Поэтому страницу вырезает оконная функция
в условии соединения, и из базы поднимается только она.

Там, где перенести срез в SQL нельзя, библиотека сама возвращается к срезу над деревом
загруженных сущностей — результат тот же, но связанные строки приходят из базы целиком:

| Случай | Почему |
|---|---|
| MySQL | Считает окно после наложения внешнего условия и молча возвращает не ту страницу |
| Незнакомый драйвер (`'ansi'`) | Оконных функций может не быть вовсе |
| Вложенный `$orderby` по соседней связи | Её алиаса в подзапросе не существует |
| `nestedPaginationInSql: false` | Перенос выключен явно |

```ts
// вернуться к прежнему поведению: срез в памяти, запрос проще
const result = await executeQuery(repo, query, {
  alias: 'User',
  nestedPaginationInSql: false,
});
```

> Выключать имеет смысл на СУБД без оконных функций, которую библиотека не распознала
> (MySQL 5.7, MariaDB 10.1 — обе сняты с поддержки), либо при неудачном плане запроса
> на конкретных данных.

---

## Сколько всего связанных строк: `$count` внутри `$expand`

Страница связи без её полного размера бесполезна — по трём постам не понять, есть ли
четвёртый. `$count=true` внутри `$expand` добавляет это число:

```bash
GET /api/users?$expand=posts($orderby=createdAt desc;$top=3;$count=true)
```

```json
[
  {
    "id": 1,
    "name": "Alice",
    "posts": [{ "id": 9 }, { "id": 7 }, { "id": 4 }],
    "posts@odata.count": 12
  }
]
```

Число приходит **аннотацией рядом со связью**, а не вместо неё: `posts` остаётся массивом,
и код, который его перебирает, ничего не замечает. Имя `<связь>@odata.count` — из OData JSON
(раздел 12), его же ждут клиенты OData.

Счётчик учитывает вложенный `$filter`, но **не** вложенные `$top` и `$skip` — иначе он всегда
равнялся бы размеру страницы. Второго обращения к базе он не стоит: значение считает скалярный
подзапрос в том же запросе.

```ts
const items = Array.isArray(result) ? result : result.items;

// Свойство с `@` читается через скобки — точечная запись здесь неприменима
const total = items[0]?.['posts@odata.count'];
```

| Случай | Поведение |
|---|---|
| `$count=false` либо опция не указана | Аннотации в ответе нет |
| `$count` у связи «к одному» | `ODataInvalidQueryError` — считать нечего |
| `$count` глубже первого уровня `$expand` | `ODataUnsupportedError` |

> Глубина ограничена по той же причине, что у `$compute` в `$select`: значения приходят
> из «сырого» результата и находят свою сущность по первичному ключу корня. Для связи связи
> пришлось бы раскладывать их по элементам каждой коллекции отдельно.

---

## Связи корня без `$expand`

`autoExpand: true` возвращает связи корневой сущности так, будто клиент перечислил их сам.
Удобно во внутреннем API, где ответ должен быть «полным объектом», а список связей меняется
вместе с сущностью:

```ts
// Книга придёт со всеми своими связями — author, publisher, category, reviews, tags
// и details, — а отзывы, названные клиентом, ещё и со своими авторами
const result = await executeQuery(repo, { $expand: 'reviews($expand=user)' }, {
  alias: 'Book',
  autoExpand: true,
});
```

Глубина — один уровень, как у `$expand=*`: дописываются связи корня, но не связи связей.
Что прислал клиент, то и остаётся: связь, названная в `$expand`, сохраняет свои вложенные
опции. `allowedExpands` соблюдается — добавляются только связи из списка.

> На публичном API включать не стоит: каждая связь — соединение, а связь «ко многим» ещё
> и умножает число строк в плоском результате. Там для того же есть `$expand`, который
> клиент указывает явно и по одной связи.

---

## Без TypeORM: только компиляция в SQL

`createQuery` и `createFilter` к базе не обращаются — они возвращают фрагменты SQL и карту
параметров. Этого достаточно, чтобы собрать запрос для любого драйвера.

### Плейсхолдеры: `:pN` → `$n`

Единственное, что придётся написать самому. Библиотека генерирует **именованные**
плейсхолдеры `:p0`, `:p1` — их понимает TypeORM. Драйверы вроде `pg` работают
с **позиционными** `$1`, `$2`, поэтому перед выполнением нужен переходник:

```ts
/**
 * Переводит именованные плейсхолдеры в позиционные и раскладывает значения по порядку.
 *
 * Шаблон намеренно узкий (`:p<цифры>`): он совпадает только с тем, что порождает сама
 * библиотека, и не заденет ни приведение типов `::text`, ни двоеточия внутри
 * строковых литералов.
 */
function toPositionalQuery(sql: string, parameters: Map<string, unknown>) {
  const values: unknown[] = [];

  const text = sql.replace(/:(p\d+)\b/g, (_match, name: string) => {
    values.push(parameters.get(name));

    return `$${values.length}`;
  });

  return { text, values };
}
```

Для `mysql2` то же самое, только вместо `$${values.length}` подставляется `?`.

### Полный запрос через `from()`

`from(table)` собирает готовый `SELECT` со всеми фрагментами: списком полей, `WHERE`,
`ORDER BY` и пагинацией.

```ts
import { createQuery } from 'odata-v4-typeorm-improved';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function selectCountries(odataQuery: string) {
  const compiled = createQuery(odataQuery, { alias: '', dialect: 'postgres' });
  const { text, values } = toPositionalQuery(compiled.from('country'), compiled.parameters);

  const result = await pool.query(text, values);

  return result.rows;
}

// selectCountries("$filter=continent eq 'Europe'&$orderby=name asc&$top=10");
```

> Имя таблицы подставляется в `from()` без экранирования. Передавайте туда только
> константу из кода, никогда не пользовательский ввод.

### Только `$filter` поверх собственного условия

Когда остальную часть SQL приложение строит само — например добавляет обязательное
ограничение, которое клиент обойти не должен:

```ts
import { createFilter } from 'odata-v4-typeorm-improved';

async function selectCountryByCode(code: string, odataFilter?: string) {
  const conditions = ['code = $1'];
  const values: unknown[] = [code];

  if (odataFilter) {
    const compiled = createFilter(odataFilter, { alias: '', dialect: 'postgres' });
    const filter = toPositionalQuery(compiled.where, compiled.parameters);

    // Смещаем нумерацию: $1 уже занят кодом страны
    conditions.push(
      `(${filter.text.replace(/\$(\d+)/g, (_m, n: string) => `$${Number(n) + values.length}`)})`
    );
    values.push(...filter.values);
  }

  const result = await pool.query(
    `SELECT * FROM country WHERE ${conditions.join(' AND ')}`,
    values
  );

  return result.rows[0];
}
```

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
GET /api/users?$filter=name ne 'Alice'
GET /api/users?$filter=id gt 10 and id lt 100
GET /api/users?$filter=(name eq 'Alice' or name eq 'Bob') and id gt 1
GET /api/users?$filter=email eq null
GET /api/users?$filter=not (name eq 'Alice') and id gt 10   # not относится к первому условию
GET /api/users?$filter=name in ('Alice','Bob')

# Поиск по подстроке
GET /api/users?$filter=contains(name,'ali')
GET /api/users?$filter=startswith(email,'admin')
GET /api/users?$filter=endswith(email,'.com')
GET /api/users?$filter=tolower(name) eq 'alice'

# Арифметика и функции
GET /api/users?$filter=id mul 2 gt 10
GET /api/users?$filter=length(name) gt 3
GET /api/users?$filter=year(createdAt) eq 2024

# Приведение типа: тотальное подмножество — число или GUID в строку, расширение числа
GET /api/users?$filter=cast(id,Edm.String) eq '42'
GET /api/users?$filter=contains(cast(id,Edm.String),'4')   # подстрока в числовой колонке

# Границы диапазона дат: условие истинно для любой непустой даты
GET /api/users?$filter=createdAt ge mindatetime() and createdAt le maxdatetime()

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
GET /api/users?$expand=posts($orderby=id desc;$top=3)   # по три последних поста на пользователя
GET /api/users?$expand=posts($top=3;$count=true)        # они же плюс posts@odata.count
GET /api/users?$expand=posts($expand=comments)

# Фильтр по полю связи (БЕЗ одновременного $expand той же связи)
GET /api/users?$filter=posts/title eq 'Hello'

# Лямбды: условие по коллекции, не размножающее корневые строки
GET /api/users?$filter=posts/any(p: p/title eq 'Hello')
GET /api/users?$filter=posts/any()                      # у пользователя вообще есть посты
GET /api/users?$filter=posts/all(p: p/published eq true)

# Поиск: грамматика OData целиком
GET /api/users?$search=alice
GET /api/users?$search=alice OR bob
GET /api/users?$search="alice smith" NOT admin

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

**Для условий по коллекции берите лямбду, а не путь связи.** Обе записи разбираются, но
компилируются по-разному: `posts/title eq 'x'` даёт `LEFT JOIN`, а он размножает корневые
строки — пользователь с тремя подходящими постами вернётся трижды, и `$top=10` отдаст
не десять пользователей. `posts/any(…)` разворачивается в `EXISTS` и число строк не меняет:

```bash
# ❌ дубли пользователей, $top считает не то
GET /api/users?$filter=posts/title eq 'x'

# ✅ EXISTS — по одной строке на пользователя
GET /api/users?$filter=posts/any(p: p/title eq 'x')
```

Для связи «многие к одному» (`$filter=author/name eq 'Ada'`) путь безопасен: там одна
связанная запись, дублей не возникает.

**Не тащите связь через тело лямбды.** Внутри тела допустим только путь `переменная/поле`;
`b/author/name` потребовал бы ещё одного соединения внутри подзапроса и отвергается
`ODataUnsupportedError`. Тот же смысл выражается вложенной лямбдой:

```bash
# ❌ ODataUnsupportedError
GET /api/authors?$filter=books/any(b: b/reviews/score gt 4)

# ✅ вложенная лямбда
GET /api/authors?$filter=books/any(b: b/reviews/any(r: r/score gt 4))
```

**Не оставляйте `$search` по всем колонкам на публичном API.** Без `searchFields` поиск идёт
по всем скалярным колонкам корня — клиент перебором строки поиска выясняет содержимое полей,
которые вы не собирались показывать, и каждый запрос сканирует таблицу целиком.
См. [Настройка `$search`](#настройка-search).

**Не оставляйте `$top` неограниченным на публичном API.** По умолчанию потолка нет:

```ts
const result = await executeQuery(repo, query, { alias: 'User', maxTop: 100 });
```

**Не открывайте сущность целиком, если в ней есть чувствительные поля.** Белые списки
по умолчанию выключены — клиент вправе достать любое поле и пройти по любой связи:

```ts
const result = await executeQuery(repo, query, {
  alias: 'User',
  allowedFields: ['id', 'name', 'email', 'posts/title'],
  allowedExpands: ['posts'],
});
```

Список покрывает и `$select`, и `$filter`, и `$orderby`, включая поля внутри функций.
