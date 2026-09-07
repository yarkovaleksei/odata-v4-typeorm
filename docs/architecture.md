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
│ odataParser          │  строка → AST (Token)
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│ TypeOrmVisitor       │  обход AST; накапливает where / select / orderby / parameters,
│                      │  дочерние посетители в includes
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
│ applyNestedPagination│  запасной срез вложенных $top / $skip по дереву сущностей
└──────────────────────┘
```

### Почему объект → строка → AST

Выглядит как лишний круг: параметры уже разобраны в объект, а мы собираем их обратно в строку.
Причина в точке входа парсера — `parseQueryOptions` принимает только строку query options.
Собирать AST вручную дороже и хрупче, чем один раз сериализовать объект.

Побочный эффект — все проблемы кодирования сосредоточены в `queryToOdataString`
(см. комментарий к функции про `encodeURI` против `encodeURIComponent`).

### Почему `$search` идёт мимо AST

`$search` в OData имеет собственную грамматику (`"a b" AND NOT c`), не пересекающуюся
с грамматикой выражений `$filter`. Разбирает её отдельный модуль `parseSearch`, а его дерево
превращает в SQL `processSearch` — минуя и `TypeOrmVisitor`, и `parseQueryOptions`. Поэтому
`$search` отделяется деструктуризацией сразу после `parseQueryParams` и в строку для парсера
выражений не попадает.

Структуру выражения — `AND`, `OR`, `NOT`, скобки — задаёт именно разобранное дерево, а не строка,
которую отдали бы движку поиска СУБД: иначе `$search` вёл бы себя по-разному на разных СУБД.
Сравнение отдельного терма при этом настраивается (`searchMode`, `searchFields`), а структура
выражения — нет.

## `TypeOrmVisitor`

Самостоятельный класс: обходит AST и накапливает SQL в строковых полях. Раньше он наследовался
от `Visitor` из `odata-v4-sql` и переопределял почти всё, что там было; вместе с уходом от
неподдерживаемых зависимостей остаток базового класса перенесён внутрь. Пять вещей, которые
он делает по-своему и ради которых наследование когда-то и понадобилось:

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

**4. `null` → `IS NULL`.** SQL не сравнивает с NULL через `=`, а узнать, что операнд окажется
литералом `null`, до его обхода нельзя — поэтому применяется пост-обработка. `VisitLiteral`
поднимает флаг `lastLiteralWasNull`, а сравнение запоминает смещения обоих операндов в целевой
строке и, если ровно одна сторона оказалась `null`, переписывает выражение в
`<другая сторона> IS [NOT] NULL`. Именно смещения, а не регулярное выражение по хвосту строки:
прошлая реализация подставляла имя идентификатора в `RegExp` без экранирования и не срабатывала,
когда `null` стоял слева (`null eq bio`).

**5. Функции OData и диалекты.** `contains` / `startswith` / `endswith` → `LIKE` с шаблоном
в параметрах; остальные транслируются в SQL-функции, причём форма выбирается по диалекту
подключения (`LENGTH` против `LEN`, `EXTRACT` против `strftime`). Узел AST без обработчика
даёт `ODataUnsupportedError`, а не тихий пропуск.

### Плейсхолдеры

Плейсхолдеры именованные (`:p0`), потому что связывать TypeORM умеет только такие.
Позиционных `?` в генерируемом SQL нет вовсе — имя пишется сразу и в `VisitLiteral`,
и в ветках `LIKE`.

Так было не всегда, и именно здесь жил дефект A-01. Базовый класс из `odata-v4-sql` писал
позиционные `?`, а отдельный проход `asType()` → `asOracleSql()` перенумеровывал их в `:pN`
заново с начала карты параметров — не видя имён, которые `VisitLiteral` расставил заранее.
`name eq 'x' and contains(title,'y')` давал `u.name = :p0 AND u.title LIKE :p0`, то есть молча
возвращал не те строки. Вместе с базовым классом исчез и этот проход: **результат обхода
корректен сразу**, никаких дополнительных вызовов после `Visit` не требуется.
Разбор — в [audit.md](./audit.md).

### Значения по умолчанию

Для незаданных опций посетитель отдаёт не пустые строки, а нейтральные SQL-выражения:
`where` попадает прямо в `andWhere`, `orderby` — в `addOrderBy`, и пустая строка там была бы
синтаксической ошибкой. Вызывающий код опирается на них ещё и как на признак «опция не задана»:

| Поле | Значение по умолчанию | Как трактуется |
|---|---|---|
| `select` | `'*'` | `$select` не задан → выбрать все невиртуальные колонки |
| `where` | `'1 = 1'` | `$filter` не задан → нейтральное условие для `andWhere` |
| `orderby` | `'1'` | `$orderby` не задан → сортировку не добавлять |

Сравнений с этими значениями по библиотеке около десятка, и все они строгие, поэтому
литералами по месту они не записаны: константы собраны в
[`VISITOR_DEFAULTS`](../src/lib/TypeOrmVisitor/defaults.ts). Записанный где-то как `'1=1'`
литерал не сломал бы ни сборку, ни линтер — SQL остался бы корректным, а проверка «опция
не задана» молча перестала бы срабатывать.

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

Вложенные `$top` / `$skip` обычным `LIMIT` выразить нельзя: в запросе с `LEFT JOIN` он
действует на весь плоский результат, а не на группу строк одного родителя. Поэтому
`buildNestedPageCondition` дописывает к `ON` подзапрос с оконной функцией `ROW_NUMBER()`,
нумерующей связанные строки внутри каждого родителя, и наружу проходит только запрошенная
страница. Условие идёт именно в `ON`, а не в `FROM`: подзапрос вместо реального соединения
сломал бы гидрацию — TypeORM собирает сущности по алиасам колонок join'а.

Там, где перенести срез в SQL нельзя — MySQL считает окно после наложения внешнего условия,
у незнакомого драйвера оконных функций может не быть, вложенный `$orderby` может ссылаться
на соседнюю связь, — работает прежний путь: `applyNestedPagination` над деревом сущностей.
Какие связи уже обработаны в SQL, `processIncludes` складывает в множество `paginated`,
чтобы срез не применился второй раз.

## Зависимости

У библиотеки нет зависимостей времени выполнения. `typeorm` (версия `^1.1.1`) объявлен
peer-зависимостью: он и так есть в проекте, который эту библиотеку подключает.

Так было не всегда. До версии 2.0.0 разбор держался на трёх пакетах — `odata-v4-parser`,
`odata-v4-sql` и `odata-v4-literal`, — не обновлявшихся с 2016–2018 годов (дефект A-10).
Часть дефектов была прямым следствием их устройства: приоритет `not`, перенумерация
плейсхолдеров, молчаливая потеря тела лямбды. Теперь разбор и обход — свои:

| Модуль | Что заменил |
|---|---|
| [odataParser/](../src/lib/odataParser/) | `odata-v4-parser`: строка OData → дерево |
| [TypeOrmVisitor/](../src/lib/TypeOrmVisitor/) | базовый `Visitor` из `odata-v4-sql` — остаток класса перенесён внутрь |
| [literal/](../src/lib/literal/) | `odata-v4-literal`: литерал → значение |

Свой парсер покрывает ровно то подмножество OData, которое библиотека транслирует
в SQL, — примерно четверть от объёма прежнего пакета. Разбор ресурсных путей, JSON-литералов
и `$apply` в нём отсутствует, потому что отсутствует и трансляция.

## Карта файлов

| Путь | Роль |
|---|---|
| [src/lib/index.ts](../src/lib/index.ts) | Публичный API пакета |
| [src/lib/types.ts](../src/lib/types.ts) | `SqlOptions`, `QueryParams`, `ParsedQueryParams` |
| [src/lib/odataParser/](../src/lib/odataParser/) | Строка OData → дерево разбора |
| [src/lib/literal/](../src/lib/literal/) | Литерал OData → значение JavaScript и текст SQL |
| [src/lib/dialect/](../src/lib/dialect/) | Драйвер TypeORM → диалект и его возможности |
| [src/lib/TypeOrmVisitor/](../src/lib/TypeOrmVisitor/) | Обход дерева, ядро компиляции |
| [src/lib/createQuery/](../src/lib/createQuery/) | Полная query string → посетитель |
| [src/lib/createFilter/](../src/lib/createFilter/) | Одно выражение `$filter` → посетитель |
| [src/lib/executeQuery/executeQuery/](../src/lib/executeQuery/executeQuery/) | Точка входа: Repository \| QueryBuilder |
| [src/lib/executeQuery/executeQueryByQueryBuilder/](../src/lib/executeQuery/executeQueryByQueryBuilder/) | Основной конвейер |
| [.../parseQueryParams/](../src/lib/executeQuery/executeQueryByQueryBuilder/parseQueryParams/) | Нормализация типов параметров |
| [src/lib/executeQuery/queryToOdataString/](../src/lib/executeQuery/queryToOdataString/) | Объект → query string |
| [src/lib/executeQuery/processIncludes/](../src/lib/executeQuery/processIncludes/) | `includes` → LEFT JOIN |
| [src/lib/executeQuery/nestedPageCondition/](../src/lib/executeQuery/nestedPageCondition/) | Вложенный `$top` / `$skip` → оконная функция |
| [src/lib/executeQuery/applyNestedPagination/](../src/lib/executeQuery/applyNestedPagination/) | Тот же срез запасным путём, по дереву сущностей |
| [src/lib/executeQuery/applyOrderBy/](../src/lib/executeQuery/applyOrderBy/) | Скомпилированный `$orderby` → `addOrderBy`; общий для корня и связей |
| [src/lib/executeQuery/relationSource/](../src/lib/executeQuery/relationSource/) | Путь связей → `FROM` и условие подзапроса; общий для лямбд и `$search` |
| [src/lib/executeQuery/sqlIdentifier/](../src/lib/executeQuery/sqlIdentifier/) | Экранирование имён таблиц и колонок по правилам драйвера |
| [src/lib/executeQuery/parseSearch/](../src/lib/executeQuery/parseSearch/) | Грамматика `$search` → дерево |
| [src/lib/executeQuery/processSearch/](../src/lib/executeQuery/processSearch/) | Дерево `$search` → SQL |
| [src/lib/executeQuery/mapToObject/](../src/lib/executeQuery/mapToObject/) | `Map` параметров → объект |
| [src/lib/ODataQueryMiddleware/](../src/lib/ODataQueryMiddleware/) | Обработчик Express |
| [src/lib/metadata/createMetadataDocument/](../src/lib/metadata/createMetadataDocument/) | `EntityMetadata` → документ `$metadata` в CSDL XML |
| [src/lib/metadata/edmType/](../src/lib/metadata/edmType/) | Типы колонок TypeORM → примитивные типы EDM |
| [src/lib/metadata/ODataMetadataMiddleware/](../src/lib/metadata/ODataMetadataMiddleware/) | Обработчик Express для маршрута `$metadata` |
| [src/test/fixtures/](../src/test/fixtures/) | Сущности и данные; ими же пользуется демо-сервер |
| [src/test/](../src/test/) | Обвязка интеграционных тестов и матрица совместимости |
| [examples/server/](../examples/server/) | Демо-сервер на Express |
