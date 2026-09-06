# Справочник API

Всё перечисленное импортируется из корня пакета:

```ts
import {
  executeQuery,
  executeQueryByQueryBuilder,
  ODataQueryMiddleware,
  ODataMetadataMiddleware,
  createMetadataDocument,
  createQuery,
  createFilter,
  TypeOrmVisitor,
  ODataUnsupportedError,
  parseQueryParams,
  queryToOdataString,
  mapToObject,
  processIncludes,
  processSearch,
} from 'odata-v4-typeorm-improved';
```

Стабильная часть контракта — первые девять. Остальное экспортируется как побочный эффект
реэкспорта барреля; рассчитывать на неизменность между минорными версиями не стоит.

---

## `executeQuery`

Основная точка входа: выполняет OData-параметры против TypeORM.

```ts
function executeQuery<T extends ObjectLiteral = ObjectLiteral>(
  repositoryOrQueryBuilder: Repository<T> | SelectQueryBuilder<T>,
  query: QueryParams,
  options?: ExecuteQueryOptions
): Promise<T[] | GetManyResponse<T>>
```

| Параметр | Описание |
|---|---|
| `repositoryOrQueryBuilder` | `Repository` → будет создан `createQueryBuilder(alias)`. `SelectQueryBuilder` → используется как есть; предустановленные условия сохраняются, OData-условия добавляются через `andWhere` |
| `query` | Объект параметров, обычно напрямую `req.query`. Значения могут быть строками |
| `options.alias` | SQL-алиас корневой сущности. Может быть любым: метаданные берутся у построителя. Для готового `SelectQueryBuilder` либо не задавайте, либо задайте его же корневой алиас |
| `options.maxTop` | Верхняя граница `$top`; запрос с бо́льшим значением усекается |
| `options.allowedFields` | Белый список полей для `$select` / `$filter` / `$orderby`. Полные пути от корня |
| `options.allowedExpands` | Белый список связей для `$expand` и путей в фильтрах |

**Возвращает** массив сущностей; `{ items, count }` — только при явном `$count=true`
(отсутствующий `$count` по OData v4, раздел 11.2.5.5, означает `false`).

```ts
// Репозиторий
const data = await executeQuery(dataSource.getRepository(User), req.query, { alias: 'User' });

// QueryBuilder с предустановленным ограничением доступа. Алиас произвольный.
const qb = dataSource
  .getRepository(User)
  .createQueryBuilder('u')
  .where('u.tenantId = :tenantId', { tenantId: req.user.tenantId });

const data = await executeQuery(qb, req.query);

// Публичный API: потолок страницы и перечень доступного
const data = await executeQuery(repository, req.query, {
  alias: 'User',
  maxTop: 100,
  allowedFields: ['id', 'name', 'posts/title'],
  allowedExpands: ['posts'],
});
```

Сужение типа результата:

```ts
const result = await executeQuery(repo, req.query, { alias: 'User' });
const items = Array.isArray(result) ? result : result.items;
const total = Array.isArray(result) ? result.length : result.count;
```

**Ошибки**

| Ошибка | Причина | HTTP |
|---|---|---|
| `ODataParseError` | Синтаксически некорректный OData-параметр | `400` |
| `ODataUnsupportedError` | Конструкция вне поддерживаемого подмножества (`in`, `any`/`all`, `replace`, геофункции) | `400` |
| `ODataInvalidQueryError` | Отрицательный `$top`/`$skip`; поле или связь вне белого списка | `400` |
| `QueryFailedError` | В `$filter` / `$orderby` указана несуществующая колонка — имена по метаданным не проверяются | `400` |
| `EntityMetadataNotFoundError` | У построителя нет метаданных и `alias` не соответствует сущности | `500` |

Первые три наследуют `ODataError` и несут признак `isClientError` — см. раздел
[Ошибки](#ошибки).

---

## `executeQueryByQueryBuilder`

То же самое, но принимает только `SelectQueryBuilder`. `executeQuery` — тонкая обёртка над ней.

```ts
function executeQueryByQueryBuilder<T extends ObjectLiteral = ObjectLiteral>(
  inputQueryBuilder: SelectQueryBuilder<T>,
  query: QueryParams,
  options?: ExecuteQueryOptions
): Promise<T[] | GetManyResponse<T>>
```

Вызывайте напрямую, если построитель у вас уже есть и различение типов в рантайме не нужно.

---

## `ODataQueryMiddleware`

Готовый обработчик Express: читает `req.query`, выполняет запрос, сам отправляет JSON.

```ts
function ODataQueryMiddleware<T extends ObjectLiteral = ObjectLiteral>(
  repositoryOrQueryBuilder: Repository<T> | SelectQueryBuilder<T>,
  settings?: ExecuteQueryOptions & {
    logger?: { error: (text: string, ...args: unknown[]) => void };
    exposeErrors?: boolean;
  }
): (req: Request, res: Response, next: NextFunction) => Promise<void>
```

```ts
app.get('/api/users', ODataQueryMiddleware(dataSource.getRepository(User), {
  alias: 'User',
  maxTop: 100,
  allowedExpands: ['posts'],
  logger: myLogger,
}));
```

**Ответы**

| Ситуация | Код | Тело |
|---|---|---|
| Успех | `200` | Результат `executeQuery` |
| Некорректный или неподдерживаемый запрос | `400` | `{ message }` с описанием проблемы |
| Ошибка SQL (обычно несуществующая колонка) | `400` | `{ message: 'Invalid OData query.' }` |
| Всё остальное | `500` | `{ message: 'Internal server error.' }` |

Текст исходной ошибки наружу не уходит — он всегда пишется в `logger`. Для сред разработки
есть `exposeErrors: true`, включающий сообщение в тело ответа.

`next(error)` вызывается только при `500`, чтобы ошибка дошла до общего обработчика приложения;
при `400` цепочка останавливается — это штатный сценарий, а не сбой.

Несмотря на название, обработчик конечный — ставьте его последним в маршруте.

**Ограничение:** репозиторий захватывается замыканием один раз, поэтому ограничения,
зависящие от запроса (текущий пользователь, тенант), так не задать — для них пишите свой
обработчик поверх `executeQuery`, пример в
[recipes.md](./recipes.md#ограничение-выдачи-правами-пользователя).

---

## `ODataMetadataMiddleware`

Готовый обработчик Express для маршрута `$metadata`: отдаёт схему сервиса в CSDL XML.

```ts
function ODataMetadataMiddleware(
  dataSource: DataSource,
  settings?: MetadataDocumentOptions & {
    logger?: { error: (text: string, ...args: unknown[]) => void };
  }
): (req: Request, res: Response, next: NextFunction) => void
```

```ts
app.get('/api/$metadata', ODataMetadataMiddleware(dataSource, {
  namespace: 'Shop',
  entities: [Author, Book],
  entitySetName: (metadata) => metadata.tableName,
}));

app.get('/api/author', ODataQueryMiddleware(dataSource.getRepository(Author), { alias: 'Author' }));
app.get('/api/book', ODataQueryMiddleware(dataSource.getRepository(Book), { alias: 'Book' }));
```

**Ответы**

| Ситуация | Код | Тело |
|---|---|---|
| Успех | `200` | Документ CSDL XML |
| Любая ошибка | `500` | `{ message: 'Internal server error.' }` |

Заголовки успешного ответа — `Content-Type: application/xml` и `OData-Version: 4.0`.
Клиентских ошибок здесь не бывает: документ не зависит от содержимого запроса.

`dataSource` может быть ещё не инициализирован в момент регистрации маршрута — документ
строится при первом запросе. Построенный документ кэшируется, неудачная попытка — нет:
иначе ранний запрос к приложению, которое ещё не подключилось к БД, закрепил бы ошибку
навсегда.

**Путь маршрута** должен совпадать с корнем сервиса, от которого клиент считает адреса
наборов: если данные лежат на `/api/Authors`, схема обязана быть на `/api/$metadata`.
В Express 5 `$` — обычный символ, экранировать его не нужно.

---

## `createMetadataDocument`

Строит документ `$metadata` (CSDL XML) по метаданным TypeORM. HTTP не касается — подходит
для NestJS, Fastify, записи схемы в файл и тестов.

```ts
function createMetadataDocument(
  dataSource: DataSource,
  options?: MetadataDocumentOptions
): string
```

```ts
const xml = createMetadataDocument(dataSource, { namespace: 'Shop' });
```

**Зачем XML.** Спецификация OData v4 определяет два представления модели — CSDL XML
и CSDL JSON, — причём XML обязательное. Клиенты исходят из этого: `ra-data-odata-server`
(react-admin), `@odata/client`, Olingo и Excel запрашивают `$metadata` и разбирают ответ
как XML. JSON они не прочитают.

**Что попадает в документ.** Ровно то, что библиотека реально отдаёт по запросу: свойства —
`nonVirtualColumns` без скрытых `select: false`, то есть тот же список, который идёт
в `SELECT` по умолчанию; связи — то, что доступно через `$expand`. Совпадение намеренное:
документ, обещающий поле, которого запрос не вернёт, хуже отсутствующего — клиент построит
по нему форму и получит пустую колонку.

**Чего в документе нет:**

| Что | Почему |
|---|---|
| Колонки с `@Column({ select: false })` | Библиотека их не возвращает и отвергает обращения к ним (дефект A-12). Включаются опцией `includeHiddenColumns` |
| Колонки встроенных сущностей (`@Column(() => Name)`) | Путь свойства содержит точку (`name.first`); в CSDL это отдельный `ComplexType`, а запросить такое поле всё равно нельзя — `name/first` разбирается как переход по связи |
| Колонки внешних ключей (`authorId`) | В модели OData за них отвечает `NavigationProperty`; TypeORM помечает их виртуальными, и в `SELECT` они тоже не попадают |
| Сущности без первичного ключа (обычно представления) | `EntityType` обязан иметь `Key` |
| Сущности, чей ключ ведёт через связь | Путь такого ключа выглядит как `book.id`, представить его `PropertyRef` нельзя |
| Таблицы связи «многие ко многим» | Самостоятельными сущностями не являются; в модели OData им соответствует сама связь |
| Связи на сущности вне документа | Ссылка на необъявленный тип сделала бы схему невалидной целиком |

### `MetadataDocumentOptions`

| Поле | Тип | По умолчанию | Назначение |
|---|---|---|---|
| `namespace` | `string` | `'Default'` | Пространство имён схемы; им же квалифицируются ссылки на типы |
| `containerName` | `string` | `'Container'` | Имя `EntityContainer` |
| `entities` | `EntityTarget[]` | все из `DataSource` | Какие сущности описывать |
| `entitySetName` | `(metadata) => string` | `(m) => m.name` | Имя `EntitySet` |
| `includeHiddenColumns` | `boolean` | `false` | Описывать ли колонки `select: false` |
| `edmType` | `(column) => string \| undefined` | — | Переопределение типа EDM; `undefined` означает «решай по умолчанию» |

**Про `entitySetName`.** Для потребителей вроде `ra-data-odata-server` это имя становится
и именем ресурса react-admin, и сегментом URL, по которому он ходит за данными, — то есть
оно обязано совпадать с маршрутом, на который повешен `ODataQueryMiddleware`. Множественное
число по умолчанию не образуется намеренно: правила английской морфологии в общем случае
не выводятся, и угаданное `Personss` молча разошлось бы с реальным маршрутом.

**Про `entities`.** Для публичного API перечисляйте сущности явно: `$metadata` содержит
имена всех полей и связей, то есть раскрывает схему БД целиком, и служебным сущностям
(сессии, аудит, очереди) там делать нечего.

**Про типы.** Соответствие типов колонок типам EDM ведёт `resolveEdmType`. Незнакомый тип
приводится к `Edm.String`, а не отвергается ошибкой: набор типов у каждой СУБД открыт
(домены, расширения), и падение генерации всего документа из-за одной экзотической колонки
было бы хуже приблизительного описания одного поля. Для таких колонок есть `edmType`.
Приближённые дробные (`float`, `real`, `double precision`) все приводятся к `Edm.Double`:
объявить хранилище точнее, чем оно есть, безопасно, обратное направление — нет.

**Ошибки.** `createMetadataDocument` бросает `Error`, если `DataSource` не инициализирован:
до `initialize()` список сущностей пуст, и молча вернулся бы синтаксически корректный, но
пустой документ — клиент решил бы, что сервис не отдаёт ни одного ресурса, и никакой ошибки
при этом не увидел бы.

---

## `createQuery`

Компилирует полную OData query string в объект с фрагментами SQL. К базе не обращается.

```ts
function createQuery(odataQuery: string | Token, options: SqlOptions): TypeOrmVisitor
```

```ts
const compiled = createQuery("$filter=Size eq 4 and Age gt 18", { alias: 'user' });

compiled.where;      // 'user.Size = :p0 AND user.Age > :p1'
compiled.select;     // '*'
compiled.orderby;    // '1'
compiled.parameters; // Map { 'p0' => 4, 'p1' => 18 }
compiled.includes;   // TypeOrmVisitor[] — по одному на сегмент $expand
```

Подстановка в TypeORM вручную:

```ts
queryBuilder
  .andWhere(compiled.where)
  .setParameters(mapToObject(compiled.parameters));
```

> Функция мутирует переданный объект `options` (проставляет `type`). Передавайте литерал,
> а не переиспользуемую переменную.

---

## `createFilter`

То же, но для одного выражения фильтра — **без** префикса `$filter=`.

```ts
function createFilter(odataFilter: string | Token, options: SqlOptions): TypeOrmVisitor
```

```ts
// GET /api/Users?$filter=Id eq 42
const compiled = createFilter(req.query.$filter, { alias: '' });

compiled.where;      // 'Id = :p0'
compiled.parameters; // Map { 'p0' => 42 }

connection.query(`SELECT * FROM users WHERE ${compiled.where}`, compiled.parameters);
```

Основной сценарий — «сырой» SQL мимо TypeORM. Полный пример, включая перевод именованных
плейсхолдеров в позиционные: [recipes.md](./recipes.md#без-typeorm-только-компиляция-в-sql).

---

## `TypeOrmVisitor`

Класс-посетитель, выполняющий обход AST. Нужен, только если вы хотите переопределить
трансляцию отдельных узлов.

```ts
class TypeOrmVisitor extends Visitor {
  includes: TypeOrmVisitor[];   // дочерние посетители $expand
  alias: string;                // SQL-алиас этой ветки
  select: string;               // '*' если $select не задан
  where: string;                // '1 = 1' если $filter не задан
  orderby: string;              // '1' если $orderby не задан
  parameters: Map<string, unknown>;
  navigationProperty: string;   // имя связи (у дочерних посетителей)

  constructor(options: SqlOptions);
  from(table: string): string;  // собрать полный SELECT (для сценария без TypeORM)
}
```

При ручном использовании обязателен `asType()` — он приводит плейсхолдеры к формату TypeORM:

```ts
const visitor = new TypeOrmVisitor({ alias: 'u', useParameters: true });
const compiled = visitor.Visit(query("$filter=name eq 'Ann'")).asType();
```

> `from(table)` подставляет имя таблицы в SQL без экранирования. Пользовательский ввод туда
> передавать нельзя.

---

## Типы

### `QueryParams`

Параметры «как пришли», до нормализации. Все поля — строки, потому что таким их кладёт Express.

```ts
interface QueryParams {
  $search?: string;
  $filter?: string;
  $orderby?: string;
  $select?: string;
  $expand?: string;
  $top?: string;
  $skip?: string;
  $count?: string;
}
```

### `ParsedQueryParams`

Результат `parseQueryParams`: пагинация и `$count` строго типизированы и всегда определены.

```ts
type ParsedQueryParams = Pick<QueryParams, '$search' | '$filter' | '$orderby' | '$select' | '$expand'> & {
  $top?: number;   // undefined = «$top не передан»; 0 = «пустая страница»
  $skip: number;
  $count: boolean;
};
```

### `ExecuteQueryOptions`

```ts
interface ExecuteQueryOptions {
  alias?: string;                        // SQL-префикс колонок
  maxTop?: number;                       // потолок $top; больше — усекается
  allowedFields?: readonly string[];     // белый список полей, полные пути от корня
  allowedExpands?: readonly string[];    // белый список связей, имена без путей
}
```

`allowedFields` перечисляет **все** поля, к которым запрос вправе обратиться, — не только
через `$select`, но и через `$filter` и `$orderby`, включая аргументы функций.
Пути указываются от корня: `['id', 'name', 'posts/title']`.

`allowedExpands` проверяется на каждом уровне вложенности: для
`$expand=posts($expand=comments)` в списке должны быть и `posts`, и `comments`.

## Ошибки

Все ошибки библиотеки наследуют `ODataError` и несут признак `isClientError` —
по нему HTTP-слой отличает `400` от `500`, не разбирая текст сообщения.

```ts
abstract class ODataError extends Error {
  abstract readonly isClientError: boolean;
}

function isODataClientError(error: unknown): error is ODataError;
```

| Класс | Когда | Дополнительные поля |
|---|---|---|
| `ODataParseError` | выражение не разобрал парсер | `source`, `position?` |
| `ODataUnsupportedError` | конструкция вне поддерживаемого подмножества | `feature`, `fragment?` |
| `ODataInvalidQueryError` | значение параметра недопустимо | `parameter` |

```ts
import { isODataClientError } from 'odata-v4-typeorm-improved';

try {
  await executeQuery(repo, req.query, { alias: 'User' });
} catch (e) {
  if (isODataClientError(e)) {
    return res.status(400).json({ message: e.message });
  }

  logger.error('OData query failed', e);

  return res.status(500).json({ message: 'Internal server error.' });
}
```

Существование этих классов — следствие правила «молча ничего не терять»: раньше
неподдержанный узел AST просто пропускался, из-за чего `$filter=not (…)` возвращал
всю таблицу вместо подмножества, а любая ошибка становилась `500` с текстом СУБД в теле.

### `GetManyResponse<T>`

```ts
interface GetManyResponse<T extends ObjectLiteral> {
  items: T[];
  count: number;   // всего строк по фильтрам, без учёта $top/$skip
}
```

Возвращается только при `$count=true`. Без `$count` ответ — обычный `T[]`, поэтому
результат `executeQuery` имеет тип `T[] | GetManyResponse<T>` и требует сужения.

### `SqlOptions`

```ts
interface SqlOptions extends BaseSqlOptions {
  alias: string;            // префикс колонок и ключ поиска метаданных
  dialect?: SqlDialect | string; // целевая СУБД; определяет выбор SQL-функций
  useParameters?: boolean;  // по умолчанию true — литералы идут в parameters, а не в SQL
  type?: SQLLang;           // перезаписывается принудительно, передавать бессмысленно
}

type SqlDialect = 'postgres' | 'mysql' | 'sqlite' | 'mssql' | 'oracle' | 'ansi';
```

`dialect` принимает и «сырой» `type` из настроек TypeORM (`'better-sqlite3'`, `'mariadb'`,
`'aurora-postgres'`) — незнакомое значение сводится к `'ansi'`. `executeQuery` подставляет
его из подключения автоматически; задавать вручную нужно только при прямом вызове
`createQuery` / `createFilter`:

```ts
createQuery('$filter=year(createdAt) eq 2023', { alias: 'u', dialect: 'sqlite' });
// where: "CAST(strftime('%Y', u.createdAt) AS INTEGER) = :p0"

createQuery('$filter=year(createdAt) eq 2023', { alias: 'u', dialect: 'postgres' });
// where: "EXTRACT(YEAR FROM u.createdAt) = :p0"
```

---

## Вспомогательные функции

Экспортируются, но относятся к внутренней кухне.

### `parseQueryParams(query): ParsedQueryParams`

Нормализация. `$skip` → целое, `$count` → boolean (**по умолчанию `false`**, как требует
OData v4, раздел 11.2.5.5), пустой `$search` → `undefined`. Входной объект не мутируется.

`$top` различает «не передан» (`undefined`) и «передан ноль» (`0`): по OData v4
(раздел 11.2.6.4) `$top=0` — корректный запрос пустой страницы, а не синоним отсутствия лимита.

```ts
parseQueryParams({ $top: '10', $skip: ' 5 ', $search: '  ' });
// → { $top: 10, $skip: 5, $search: undefined, $count: false }

parseQueryParams({});          // → { $top: undefined, $skip: 0, $count: false }
parseQueryParams({ $top: '0' }); // → { $top: 0, ... } — вернётся пустая страница
```

### `queryToOdataString(query): string`

Объект → query string. Берёт только ключи с `$`, пропускает `null` / `undefined`.

```ts
queryToOdataString({ $top: 5, $filter: "name eq 'Ann'", page: 2 });
// → "$top=5&$filter=name%20eq%20'Ann'"   (page отброшен)
```

### `mapToObject(map, deep?): Record<K, V>`

`Map` параметров → объект для `setParameters`. `null` / `undefined` → `{}`.

```ts
mapToObject(new Map([['p0', 'Ann'], ['p1', 18]]));  // → { p0: 'Ann', p1: 18 }
```

### `processIncludes(qb, odataQuery, alias, parentMetadata): SelectQueryBuilder`

Разворачивает `includes` в `LEFT JOIN`. Вложенные `$top` / `$skip` внутри `$expand` игнорируются.

### `processSearch(qb, metadata, $search, alias): void`

Добавляет условия `$search`. Мутирует построитель на месте, ничего не возвращает.
Работает только по колонкам корневой сущности.

### Списки типов колонок для `$search`

```ts
searchableTextColumnTypes    // varchar, text, char, citext, nvarchar, string, ...  → LIKE
searchableNumberColumnTypes  // int, bigint, decimal, float, real, number, ...      → равенство
```

Оба — белые списки. Осознанно не включены `uuid`, `json`, `enum`, `date`, `bytea`.
