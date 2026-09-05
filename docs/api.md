# Справочник API

Всё перечисленное импортируется из корня пакета:

```ts
import {
  executeQuery,
  executeQueryByQueryBuilder,
  ODataQueryMiddleware,
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

Стабильная часть контракта — первые семь. Остальное экспортируется как побочный эффект
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
| `options.alias` | SQL-алиас корневой сущности. **Обязан совпадать с именем класса сущности или именем её таблицы** — по нему ищутся метаданные |

**Возвращает** `{ items, count }`, если `$count` не выключен явно (он включён по умолчанию),
иначе — массив сущностей.

```ts
// Репозиторий
const data = await executeQuery(dataSource.getRepository(User), req.query, { alias: 'User' });

// QueryBuilder с предустановленным ограничением доступа
const qb = dataSource
  .getRepository(User)
  .createQueryBuilder('User')
  .where('User.tenantId = :tenantId', { tenantId: req.user.tenantId });

const data = await executeQuery(qb, req.query);
```

Сужение типа результата:

```ts
const result = await executeQuery(repo, req.query, { alias: 'User' });
const items = Array.isArray(result) ? result : result.items;
const total = Array.isArray(result) ? result.length : result.count;
```

**Ошибки**

| Ошибка | Причина |
|---|---|
| `Error: Fail at <n>` | Синтаксически некорректный OData-параметр |
| `ODataUnsupportedError` | Конструкция за пределами поддерживаемого подмножества (`in`, `any`/`all`, `replace`, геофункции). Клиентская ошибка — отдавайте `400` |
| `EntityMetadataNotFoundError` | `alias` не совпадает с именем сущности/таблицы |
| `QueryFailedError` | В `$filter` / `$orderby` указана несуществующая колонка — имена по метаданным не проверяются |

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
  settings?: {
    alias?: string;
    logger?: { error: (text: string, ...args: unknown[]) => void };
  }
): (req: Request, res: Response, next: NextFunction) => Promise<void>
```

```ts
app.get('/api/users', ODataQueryMiddleware(dataSource.getRepository(User), {
  alias: 'User',
  logger: myLogger,
}));
```

**Ответы**

| Ситуация | Код | Тело |
|---|---|---|
| Успех | `200` | Результат `executeQuery` |
| Любое исключение | `500` | `{ message: 'Internal server error.', error: { message } }` |

Несмотря на название, обработчик конечный — ставьте его последним в маршруте.

**Ограничения, о которых стоит знать до внедрения:**

- Репозиторий захватывается замыканием один раз, поэтому ограничения, зависящие от запроса
  (текущий пользователь, тенант), так не задать — для них пишите свой обработчик поверх
  `executeQuery`.
- Клиентские ошибки (неверный `$filter`) отдаются как `500`, а не `400`, и наружу уходит
  текст ошибки СУБД. См. [audit.md](./audit.md), дефект A-07. Если API публичный, лучше
  использовать `executeQuery` и обрабатывать ошибки самостоятельно — пример в
  [recipes.md](./recipes.md#express-свой-обработчик-рекомендуется-для-публичного-api).

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

Основной сценарий — «сырой» SQL мимо TypeORM. Полный пример: [src/example/sql.ts](../src/example/sql.ts).

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
  alias?: string;
}
```

### `ODataUnsupportedError`

Бросается, когда запрос содержит конструкцию, которую библиотека не умеет транслировать
в SQL. Ошибка **клиентская** — на уровне HTTP ей соответствует `400`.

```ts
class ODataUnsupportedError extends Error {
  readonly feature: string;    // 'AnyExpression', 'geo.distance()', 'lambda operators (any/all)'
  readonly fragment?: string;  // исходный фрагмент запроса
}
```

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

Существование этой ошибки — следствие правила «молча ничего не терять»: раньше
неподдержанный узел AST просто пропускался, из-за чего `$filter=not (…)` возвращал
всю таблицу вместо подмножества.

### `GetManyResponse<T>`

```ts
interface GetManyResponse<T extends ObjectLiteral> {
  items: T[];
  count: number;   // всего строк по фильтрам, без учёта $top/$skip
}
```

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

Нормализация. `$skip` → целое, `$count` → boolean (**по умолчанию `true`**),
пустой `$search` → `undefined`. Входной объект не мутируется.

`$top` различает «не передан» (`undefined`) и «передан ноль» (`0`): по OData v4
(раздел 11.2.6.4) `$top=0` — корректный запрос пустой страницы, а не синоним отсутствия лимита.

```ts
parseQueryParams({ $top: '10', $skip: ' 5 ', $search: '  ' });
// → { $top: 10, $skip: 5, $search: undefined, $count: true }

parseQueryParams({});          // → { $top: undefined, $skip: 0, $count: true }
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
