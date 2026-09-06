# Архитектура

Как OData-строка превращается в запрос TypeORM и почему конвейер устроен именно так.

## Слои

Библиотека даёт три уровня доступа. Каждый следующий — тоньше и ближе к SQL.

```
┌───────────────────────────────────────────────────────────────┐
│ 1. ODataQueryMiddleware        Express-обработчик             │
│    читает req.query, сам отправляет JSON-ответ                │
├───────────────────────────────────────────────────────────────┤
│ 2. executeQuery                Repository | SelectQueryBuilder │
│    executeQueryByQueryBuilder  выполняет запрос, отдаёт данные │
├───────────────────────────────────────────────────────────────┤
│ 3. createQuery / createFilter  OData → фрагменты SQL           │
│    TypeOrmVisitor              без обращения к БД              │
└───────────────────────────────────────────────────────────────┘
```

Уровень 3 не зависит от TypeORM по сути (только тип `ObjectLiteral` в сигнатурах) и годится
для «сырых» драйверов; рецепт с `pg` — в [recipes.md](./recipes.md#без-typeorm-только-компиляция-в-sql).

Особняком стоит слой схемы — он описывает модель, а не выполняет запросы, и потому
в конвейер не входит вовсе:

```
┌───────────────────────────────────────────────────────────────┐
│ ODataMetadataMiddleware        Express-обработчик $metadata   │
│ createMetadataDocument         EntityMetadata → CSDL XML      │
└───────────────────────────────────────────────────────────────┘
```

Источник данных для него — метаданные TypeORM, а не AST OData, поэтому парсер здесь
не участвует. Единственная связь с остальной библиотекой смысловая, но обязательная:
перечень описываемых колонок совпадает с тем, что `executeQueryByQueryBuilder` кладёт
в `SELECT` по умолчанию. Документ, обещающий поле, которого запрос не вернёт, хуже
отсутствующего.

## Конвейер выполнения

```
req.query  { $filter: "name eq 'Ann'", $top: '10', $search: 'x' }
    │
    ▼
┌──────────────────────┐
│ parseQueryParams     │  $top/$skip → number, $count → boolean (по умолчанию false),
│                      │  пустой $search → undefined
└──────────┬───────────┘
           │  $search отделяется здесь и дальше по конвейеру не идёт
           ▼
┌──────────────────────┐
│ queryToOdataString   │  объект → "$filter=name%20eq%20'Ann'&$top=10&$count=true"
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│ odata-v4-parser      │  строка → AST (Token)
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│ TypeOrmVisitor       │  обход AST; накапливает where / select / orderby / parameters,
│   + asType()         │  дочерние посетители в includes; asType() чинит плейсхолдеры
└──────────┬───────────┘
           ▼
┌──────────────────────────────────────────────────────────────┐
│ executeQueryByQueryBuilder                                   │
│   .select(rootSelect)          ← $select либо все колонки    │
│   .andWhere(where)             ← $filter                     │
│   .setParameters(params)                                     │
│   processIncludes(...)         ← $expand → LEFT JOIN         │
│   .addOrderBy(...)             ← $orderby                    │
│   processSearch(...)           ← $search → LIKE ... OR ...   │
│   .skip(...) .take(...)        ← $skip / $top                │
│   getMany() | getManyAndCount()                              │
└──────────┬───────────────────────────────────────────────────┘
           ▼
┌──────────────────────┐
│ applyNestedPagination│  срез вложенных $top / $skip по дереву сущностей
└──────────────────────┘
```

### Почему объект → строка → AST

Выглядит как лишний круг: параметры уже разобраны в объект, а мы собираем их обратно в строку.
Причина в `odata-v4-parser` — его публичный вход принимает только строку query options.
Собирать AST вручную дороже и хрупче, чем один раз сериализовать объект.

Побочный эффект — все проблемы кодирования сосредоточены в `queryToOdataString`
(см. комментарий к функции про `encodeURI` против `encodeURIComponent`).

### Почему `$search` идёт мимо AST

`$search` в OData имеет собственную грамматику (`"a b" AND NOT c`), которую `odata-v4-parser`
этой версии не разбирает. Здесь реализована упрощённая семантика — вся строка ищется как
подстрока по всем скалярным колонкам — и она собирается напрямую в SQL через `processSearch`,
минуя посетителя. Поэтому `$search` отделяется деструктуризацией сразу после `parseQueryParams`.

## `TypeOrmVisitor`

Наследник `Visitor` из `odata-v4-sql`. Базовый класс обходит AST и накапливает SQL в строковых
полях; наследник меняет пять вещей.

**1. Порядок обхода query options.** `queryOptionsSort = [Expand, Filter, Select]` — сначала
`$expand`, потом `$filter`, потом `$select`. Без этого фильтр по пути `связь/поле` разбирался бы
раньше, чем появился бы JOIN-алиас связи.

**2. `$expand` → дерево посетителей.** Каждый сегмент `$expand` получает собственный
`TypeOrmVisitor` со своими `select` / `where` / `orderby`; они складываются в `includes`.
Счётчик параметров `parameterSeed` передаётся вниз и забирается обратно, чтобы нумерация
`:p0, :p1, …` была сквозной по всему дереву.

**3. Пути `связь/поле` в фильтре.** `VisitPropertyPathExpression` в контексте `where` создаёт
«виртуальный» include: `select = ''` (колонки не выбираем) и `where = '1 = 1'` (JOIN без условия).
Так `$filter=posts/title eq 'x'` работает и без явного `$expand`.

**4. `null` → `IS NULL`.** SQL не сравнивает с NULL через `=`. К моменту обхода правого операнда
уже поздно что-то менять, поэтому применяется пост-обработка: `VisitLiteral` записывает признак
в `context.literal`, а `VisitEqualsExpression` переписывает готовый хвост строки `where`
регулярным выражением.

**5. Функции OData и диалекты.** `contains` / `startswith` / `endswith` → `LIKE` с шаблоном
в параметрах; остальные транслируются в SQL-функции, причём форма выбирается по диалекту
подключения (`LENGTH` против `LEN`, `EXTRACT` против `strftime`). Узел AST без обработчика
даёт `ODataUnsupportedError`, а не тихий пропуск.

### Плейсхолдеры: почему `SQLLang.Oracle`

Диалект жёстко ставится в Oracle и в конструкторе, и в `createQuery` / `createFilter`.
К Oracle как СУБД это отношения не имеет: важно только то, что в базовом классе именно
ветка `asOracleSql()` переписывает позиционные `?` в именованные `:pN` — а связывать
TypeORM умеет только именованные.

Отсюда вытекает контракт объекта: **результат обхода корректен только после `asType()`**.
`createQuery` и `createFilter` вызывают его сами; при ручном использовании `TypeOrmVisitor`
вызывать обязательно.

Здесь когда-то жил дефект A-01: `VisitLiteral` писал `:pN` напрямую, а LIKE-ветки — `?`,
и `asOracleSql()` перенумеровывал найденные `?` заново с начала карты параметров, отчего
`name eq 'x' and contains(title,'y')` молча возвращал не те строки. Теперь имя пишется
сразу везде, и `asOracleSql()` нечего переписывать. Разбор — в [audit.md](./audit.md).

### Значения по умолчанию

Базовый посетитель для незаданных опций отдаёт не пустые строки, а нейтральные SQL-выражения.
Вызывающий код опирается на них как на признак «опция не задана»:

| Поле | Значение по умолчанию | Как трактуется |
|---|---|---|
| `select` | `'*'` | `$select` не задан → выбрать все невиртуальные колонки |
| `where` | `'1 = 1'` | `$filter` не задан → нейтральное условие для `andWhere` |
| `orderby` | `'1'` | `$orderby` не задан → сортировку не добавлять |

## `processIncludes`

Разворачивает дерево `includes` в вызовы `leftJoin` / `leftJoinAndSelect`.

Тип JOIN выбирается по `select` дочернего посетителя:

| `item.select` | Что это значит | Действие |
|---|---|---|
| `'*'` | `$expand=posts` без вложенного `$select` | `leftJoinAndSelect` — TypeORM добавит все колонки |
| `'Author_books.id, Author_books.title'` | `$expand=books($select=id,title)` | `leftJoin` + `addSelect` перечисленных колонок |
| `''` | «виртуальный» include из фильтра по пути | `leftJoin` + пустой `addSelect` — JOIN без выборки |

JOIN всегда LEFT: `$expand` не должен отсеивать сущности без связанных записей, иначе он
работал бы как скрытый фильтр.

Вложенные `$expand` обрабатываются рекурсией: по `propertyPath` в метаданных родителя ищется
связь, из неё берётся целевая сущность и её метаданные, и функция вызывается для следующего уровня.

Алиасы JOIN строятся по пути связи: `Author` → `Author_books` → `Author_books_reviews`.
Схема детерминированная, поэтому `$expand` и `$filter` по одной и той же связи приходят
к одному имени и к одному JOIN.

Вложенные `$top` / `$skip` в SQL не попадают: `LIMIT` в запросе с `LEFT JOIN` действует
на весь плоский результат, а не на группу. Срез делает `applyNestedPagination` уже
над деревом сущностей.

## Отношение к вышестоящим библиотекам

```
odata-v4-typeorm-improved
├── odata-v4-parser   0.1.29   строка OData → AST
├── odata-v4-sql      0.1.2    базовый Visitor: AST → фрагменты SQL
└── odata-v4-literal  0.1.1    разбор литералов
```

Все три не поддерживаются с 2016–2018 годов. Практические следствия описаны в
[audit.md](./audit.md), дефект A-10; стратегия — в [roadmap.md](./roadmap.md), этап 5.

## Карта файлов

| Путь | Роль |
|---|---|
| [src/lib/index.ts](../src/lib/index.ts) | Публичный API пакета |
| [src/lib/types.ts](../src/lib/types.ts) | `SqlOptions`, `QueryParams`, `ParsedQueryParams` |
| [src/lib/TypeOrmVisitor/](../src/lib/TypeOrmVisitor/) | Обход AST, ядро компиляции |
| [src/lib/createQuery/](../src/lib/createQuery/) | Полная query string → посетитель |
| [src/lib/createFilter/](../src/lib/createFilter/) | Одно выражение `$filter` → посетитель |
| [src/lib/executeQuery/executeQuery/](../src/lib/executeQuery/executeQuery/) | Точка входа: Repository \| QueryBuilder |
| [src/lib/executeQuery/executeQueryByQueryBuilder/](../src/lib/executeQuery/executeQueryByQueryBuilder/) | Основной конвейер |
| [.../parseQueryParams/](../src/lib/executeQuery/executeQueryByQueryBuilder/parseQueryParams/) | Нормализация типов параметров |
| [src/lib/executeQuery/queryToOdataString/](../src/lib/executeQuery/queryToOdataString/) | Объект → query string |
| [src/lib/executeQuery/processIncludes/](../src/lib/executeQuery/processIncludes/) | `includes` → LEFT JOIN |
| [src/lib/executeQuery/processSearch/](../src/lib/executeQuery/processSearch/) | `$search` → LIKE / равенство |
| [src/lib/executeQuery/mapToObject/](../src/lib/executeQuery/mapToObject/) | `Map` параметров → объект |
| [src/lib/ODataQueryMiddleware/](../src/lib/ODataQueryMiddleware/) | Обработчик Express |
| [src/lib/metadata/createMetadataDocument/](../src/lib/metadata/createMetadataDocument/) | `EntityMetadata` → документ `$metadata` в CSDL XML |
| [src/lib/metadata/edmType/](../src/lib/metadata/edmType/) | Типы колонок TypeORM → примитивные типы EDM |
| [src/lib/metadata/ODataMetadataMiddleware/](../src/lib/metadata/ODataMetadataMiddleware/) | Обработчик Express для маршрута `$metadata` |
| [src/test/fixtures/](../src/test/fixtures/) | Сущности и данные; ими же пользуется демо-сервер |
| [src/test/](../src/test/) | Обвязка интеграционных тестов и матрица совместимости |
| [examples/server/](../examples/server/) | Демо-сервер на Express |
