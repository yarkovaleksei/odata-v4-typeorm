# Разработка

Всё, что нужно для работы над самим пакетом: команды, структура, отладка, релиз.

## Требования

Есть два способа работать с проектом. Оба поддерживаются, выбирайте по вкусу.

### В Docker — окружение одинаково у всех

Нужен только Docker с плагином Compose. Версия Node, системные библиотеки для нативных
модулей и версии СУБД зафиксированы в образе и `compose.yaml`, поэтому результат не зависит
от того, что установлено на машине.

```bash
git clone https://github.com/yarkovaleksei/odata-v4-typeorm-improved.git
cd odata-v4-typeorm-improved

yarn docker:test        # lint + тесты + сборка на SQLite
yarn docker:test:all    # матрица OData на SQLite, PostgreSQL и MySQL
yarn docker:down        # погасить всё и удалить данные
```

Зависимости ставятся **при старте контейнера**, а не при сборке образа: образ не нужно
пересобирать после правки `package.json`, и разработчик всегда получает состояние,
соответствующее текущему `yarn.lock`. Чтобы это не занимало минуты на каждом запуске,
`node_modules` и кэш yarn лежат в именованных томах — повторный запуск занимает секунды.

Пересобирать образ нужно, только если изменился сам `docker/Dockerfile`:

```bash
yarn docker:build
```

### Локально — быстрее цикл правка-проверка

| Инструмент | Версия | Примечание |
|---|---|---|
| Node.js | 20, 22 или 24 | CI прогоняет все три |
| Yarn | 1.x (classic) | Через Corepack; в проекте `yarn.lock` |
| TypeScript | 6.x | Из devDependencies, глобально ставить не нужно |

```bash
yarn install
yarn verify                 # lint + тесты + сборка
yarn db:up && yarn test:all  # матрица на трёх СУБД, базы из compose
```

---

## Команды

### Основные

| Команда | Что делает |
|---|---|
| `yarn test:unit` | Прогон всех тестов Jest на SQLite в памяти |
| `yarn test:postgres` | Тот же набор тестов на PostgreSQL |
| `yarn test:mysql` | Тот же набор на MySQL |
| `yarn test:all` | Последовательно на всех трёх СУБД |
| `yarn verify` | lint + тесты + сборка — то же, что делает CI |
| `yarn lint` | ESLint по всем `.ts` / `.tsx` |
| `yarn lint:fix` | То же с автоисправлением |
| `yarn build` | Чистая пересборка в `build/` (`rm -rf ./build && tsc -p tsconfig.build.json`) |
| `yarn db:up` | Поднять PostgreSQL и MySQL для прогона с хоста |
| `yarn server` | Поднять демо-сервер из `examples/server` с автоперезапуском |

### Docker

| Команда | Что делает |
|---|---|
| `yarn docker:test` | `yarn verify` внутри контейнера |
| `yarn docker:test:all` | Матрица на всех трёх СУБД внутри контейнера |
| `yarn docker:lint` | Только ESLint |
| `yarn docker:sh` | Интерактивная оболочка внутри контейнера |
| `yarn docker:build` | Пересобрать образ (нужно только при правке `docker/Dockerfile`) |
| `yarn docker:down` | Погасить контейнеры и удалить тома |

### Публикация

| Команда | Что делает |
|---|---|
| `yarn release` | `build` + `npm publish` |
| `yarn release:beta` | `build` + `npm publish --tag beta` |

Обычно вручную не запускаются: публикацию делает
[`.github/workflows/publish.yaml`](../.github/workflows/publish.yaml) по созданию GitHub Release,
через OIDC Trusted Publishing и с `--provenance`.

### Полезные вызовы Jest напрямую

Скрипт `test:unit` пробрасывает аргументы, поэтому флаги Jest работают через `--`:

```bash
# Один файл
yarn test:unit --testPathPatterns=processSearch

# Тесты, чьё имя содержит подстроку
yarn test:unit -t 'должен обработать AND/OR'

# Watch-режим
yarn test:unit --watch

# Покрытие (в конфиге не включено, но флаг работает)
yarn test:unit --coverage

# Подробный вывод по каждому тесту
yarn test:unit --verbose

# Показать, какие файлы Jest вообще видит
yarn test:unit --listTests
```

### Полезные вызовы ESLint напрямую

```bash
# Один каталог
npx eslint src/lib/TypeOrmVisitor --ext .ts

# Проверить, что линтер действительно видит файлы (а не молча линтует ноль)
npx eslint . --ext .ts,.tsx -f json | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log('files:',JSON.parse(d).length))"

# Компактный вывод
npx eslint . --ext .ts,.tsx -f unix
```

### Проверка содержимого npm-пакета

Состав пакета задан белым списком `files` в `package.json`; в CI есть шаг
«Check package contents», который падает, если внутрь попал тестовый файл.
Локально то же самое:

```bash
yarn build
npm pack --dry-run

# Список файлов с размерами
npm pack --dry-run --json | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d)[0];console.log('files:',j.entryCount,'unpacked:',j.unpackedSize);console.log(j.files.map(f=>f.path).join('\n'))})"

# Не просочились ли тесты
npm pack --dry-run 2>&1 | grep -c '\.test\.'
```

### Быстрая проверка компиляции OData без БД

Самый удобный способ посмотреть, во что превращается конкретный запрос:

```bash
yarn build

node -e "
const { createQuery } = require('./build/src/lib/createQuery');
const q = createQuery(\"\\\$filter=name eq 'Ann' and age gt 18\", { alias: 'user' });
console.log('where   :', q.where);
console.log('select  :', q.select);
console.log('orderby :', q.orderby);
console.log('params  :', [...q.parameters]);
console.log('includes:', q.includes.map(i => ({ nav: i.navigationProperty, alias: i.alias, select: i.select })));
"
```

### Что запустить перед коммитом

```bash
yarn verify          # локально
yarn docker:test     # либо то же самое в контейнере
```

Ровно эту цепочку выполняет CI ([`ci.yaml`](../.github/workflows/ci.yaml)) на Node 20/22/24,
плюс отдельная джоба прогоняет матрицу на PostgreSQL и MySQL.

---

## Структура проекта

```
docker/
├── Dockerfile               образ для прогона тестов; зависимости ставит entrypoint
└── entrypoint.sh            yarn install, затем переданная команда
compose.yaml                 сервис tests + PostgreSQL + MySQL

src/
├── lib/                     ← публикуемый код
│   ├── index.ts             публичный API
│   ├── types.ts             общие типы
│   ├── TypeOrmVisitor/      обход AST OData, ядро компиляции
│   ├── createQuery/         query string → посетитель
│   ├── createFilter/        одно выражение $filter → посетитель
│   ├── ODataQueryMiddleware/ обработчик Express
│   └── executeQuery/
│       ├── executeQuery/               Repository | QueryBuilder → выполнение
│       ├── executeQueryByQueryBuilder/ основной конвейер
│       │   └── parseQueryParams/       нормализация типов
│       ├── queryToOdataString/         объект → query string
│       ├── processIncludes/            includes → LEFT JOIN
│       ├── processSearch/              $search → LIKE / равенство
│       └── mapToObject/                Map → объект
└── test/                    ← обвязка тестов (в пакет не идёт)
    ├── entity/              User/Post — базовые; Author/Book/Review — для матрицы
    ├── matrix/              матрица совместимости с OData
    └── setup/               DataSource, сиды, выбор СУБД

examples/server/             ← демо-сервер на Express
docs/                        ← эта документация
```

Соглашение по модулям: каталог на сущность, внутри `<name>.ts`, `<name>.test.ts`
и баррель `index.ts` с единственным `export * from './<name>'`.

---

## Тесты

### Как устроено

`jest.config.js` задаёт `rootDir: 'src'` и `setupFilesAfterEnv: ['./test/setup/setup.ts']`.
Обвязка поднимает базу один раз на прогон и **пересоздаёт данные перед каждым тестом**
(`clearDatabase` + `seedDatabase`), поэтому тесты независимы и порядок не важен.

Хуки регистрируются глобально — даже чисто модульные тесты стартуют с живым `DataSource`.

### Прогон на PostgreSQL и MySQL

СУБД выбирается переменной `TEST_DB`; по умолчанию SQLite в памяти.

```bash
# в контейнере — окружение одинаково у всех
yarn docker:test:all

# либо с хоста, если Node установлен локально
yarn db:up                 # PostgreSQL на 55432, MySQL на 53306
yarn test:all
yarn docker:down
```

Внутри сети compose базы доступны по именам сервисов (`postgres:5432`, `mysql:3306`);
на хост они проброшены на нестандартные порты, чтобы не конфликтовать с локально
установленными СУБД. Адреса задаются переменными `TEST_POSTGRES_HOST` / `TEST_MYSQL_PORT`
и т.п. — обе пары сразу, потому что `yarn test:all` ходит в обе базы за один запуск.

Зачем это нужно: трансляция функций OData зависит от диалекта, и одного SQLite мало —
сгенерированная строка SQL может выглядеть правильно и при этом не выполниться. Первый же
прогон на MySQL нашёл дефект A-15, из-за которого там падал любой запрос без `$top`.

Отличия прогона на внешней СУБД:

- схему создаёт `globalSetup` один раз до старта воркеров: иначе параллельные
  `synchronize(true)` дерутся за одну базу;
- `maxWorkers: 1` — база одна на всех, и `beforeEach` одного воркера очищал бы таблицы,
  пока другой из них читает;
- часовой пояс принудительно `UTC` (`jest.config.js`): SQLite сохраняет момент в UTC,
  PostgreSQL пишет локальные составляющие, и без общей зоны проверки вида
  `hour(registeredAt) eq 8` расходились бы.

Случаи, где расхождение — свойство самой СУБД, помечаются в матрице полем `skipOn`
с обязательным пояснением:

```ts
{
  name: 'div (целочисленное деление)',
  query: { $filter: 'age div 2 gt 20' },
  expected: [2],
  skipOn: { mysql: 'в MySQL оператор / не выполняет целочисленное деление' },
}
```

### Тестовые данные

`src/test/setup/seed.sql`:

Данные задаются программно в `seedDatabase` (`src/test/setup/dataSource.ts`).
Раньше они лежали в `seed.sql`, но сырой SQL непереносим: идентификатор `"user"` в MySQL
по умолчанию читается как строковый литерал, а `user` — зарезервированное слово.

| Таблица | Записи | Для чего |
|---|---|---|
| `user` | Alice (id 1), Bob (id 2) | Базовые тесты `executeQuery` |
| `post` | По две публикации на каждого | Связь один-ко-многим |
| `author` | Ada, Grace, Alan, Barbara | Матрица: все типы колонок |
| `book` | 5 книг, одна намеренно без автора | Матрица: LEFT JOIN, второй уровень связи |
| `review` | 5 отзывов | Матрица: третий уровень связи |

Значения в `author` подобраны так, чтобы каждый оператор давал непустую и при этом
не полную выборку — иначе тест не отличит работающий фильтр от отброшенного.
Дробные — без «половинок»: округление ровно `4.5` у СУБД разное.

`clearDatabase` не просто удаляет строки, а **сбрасывает счётчики идентификаторов**
(`TRUNCATE ... RESTART IDENTITY` в PostgreSQL, `TRUNCATE` в MySQL). Фикстуры задают `id`
явно, но при `@PrimaryGeneratedColumn()` значение назначает база: без сброса второй прогон
сида на PostgreSQL выдавал уже `3, 4` вместо `1, 2`.

### Два стиля тестов

| Стиль | Где | Что проверяет |
|---|---|---|
| Модульные на строке SQL | `TypeOrmVisitor.test.ts` | Точный вид сгенерированного SQL, в том числе по диалектам |
| Модульные с моком QueryBuilder | `executeQueryByQueryBuilder.test.ts` | Факт и аргументы вызовов методов TypeORM |
| Матричные на реальной SQLite | `src/test/matrix/` | Итоговые данные: какие строки вернул запрос |

Моки не ловят дефекты генерации SQL — именно поэтому первые три года жизни проекта
все тесты были зелёными при неверно работающих `$filter` и `$expand`.
Новые тесты на поведение пишите матричными.

### Как добавить интеграционный тест

```ts
import { executeQuery } from '../../lib/executeQuery';
import { User } from '../../test/entity';
import { dataSource } from '../../test/setup/dataSource';

describe('мой сценарий', () => {
  it('фильтрует по имени', async () => {
    const result = await executeQuery(
      dataSource.getRepository(User),
      { $filter: "name eq 'Alice'" },
      { alias: 'User' }   // ← имя сущности, не произвольный алиас
    );

    expect(result).toEqual({
      items: [{ id: 1, name: 'Alice', email: 'alice@example.com' }],
      count: 1,
    });
  });
});
```

Инициализировать `DataSource` не нужно — это делает глобальная обвязка.

### Как посмотреть реальный SQL

Включите логирование в [`src/test/setup/dataSource.ts`](../src/test/setup/dataSource.ts):

```diff
- logging: false,
+ logging: true,
```

---

## Отладка

### VS Code

В [`.vscode/launch.json`](../.vscode/launch.json) есть конфигурация
«Запустить скрипт: test:unit» — `F5` запускает весь набор тестов с отладчиком.
Точки останова работают прямо в `.ts` благодаря `ts-jest` и `sourceMap: true`.

### Node inspector

```bash
node --inspect-brk node_modules/.bin/jest --runInBand --testPathPatterns=TypeOrmVisitor
```

Затем `chrome://inspect` либо «Attach to Node Process» в VS Code.
`--runInBand` обязателен: без него Jest разводит тесты по воркерам и отладчик к ним не цепляется.

### Что смотреть при разборе дефекта

1. Что отдал парсер и посетитель — быстрым `node -e` (см. выше). Это отсекает половину гипотез:
   ошибка либо на стадии компиляции OData, либо уже в TypeORM.
2. Итоговый SQL — `logging: true` в тестовом `DataSource`.
3. Есть ли в stdout строки `Unhandled node type: …` — базовый `Visitor` печатает их вместо
   ошибки, когда узел AST не поддерживается (см. [audit.md](./audit.md), A-11).

---

## Демо-сервер и конструктор запросов

```bash
yarn server
```

Открывает <http://localhost:3001/> — страницу, где запрос собирается полями формы, рядом
показывается получившийся URL, а по кнопке выполняется и отдаёт ответ. Самый быстрый способ
и попробовать библиотеку, и проверить правку в ней: `nodemon` следит и за
`examples/server/src`, и за `src/lib`.

Демо работает на SQLite; база создаётся и наполняется при старте (`dropSchema: true`),
поэтому данные всегда те же, что описаны в примерах и коллекции Postman.

| Адрес | Что отдаёт |
|---|---|
| `/` | конструктор запросов |
| `/api/posts` | OData-эндпоинт (также `authors`, `users`, `categories`, `comments`) |
| `/api/posts/$metadata` | поля и связи сущности |
| `/api/$metadata` | схема всех сущностей — её читает конструктор |

Отдельной установки у демо нет: он живёт на зависимостях корня. Раньше у него был свой
`package.json` с собственным `typeorm`, и две копии библиотеки давали несовместимые типы —
файл не компилировался вовсе.

Коллекция Postman на 40 запросов, включая папку «Ошибки» с ожидаемыми `400`:
[`examples/postman/`](../examples/postman/). Каждый запрос проверен против живого сервера.

Типы демо проверяются в CI (`yarn server:typecheck`) — раньше он не был покрыт ничем
и годами оставался сломанным незамеченным.

---

## Стиль кода

- **ESLint 10**, flat config в [`eslint.config.ts`](../eslint.config.ts): рекомендованные наборы
  `@eslint/js` и `typescript-eslint` плюс `eslint-plugin-typeorm-typescript`
  (сверяет TS-типы полей с декораторами колонок).
- **Prettier** — конфиг [`.prettierrc`](../.prettierrc) есть (2 пробела, одинарные кавычки,
  точки с запятой, ширина 100), но сам пакет **не установлен** и в CI формат не проверяется
  ([roadmap.md](./roadmap.md), задача R-22). Настройте форматирование в редакторе по этому конфигу.
- Комментарии и сообщения тестов — на русском, как и в существующем коде.
- Публичные функции документируются JSDoc с `@param`, `@returns`, `@example` и — если поведение
  неочевидно — `@remarks`.

Правила, отключённые осознанно:

| Правило | Причина |
|---|---|
| `@typescript-eslint/explicit-function-return-type` | Вывод типов достаточен, сигнатуры и так читаемы |
| `@typescript-eslint/ban-ts-comment` | `@ts-ignore` нужен для динамического `this[context.target]` в посетителе |

`strict` в TypeScript **выключен** — включение запланировано
([roadmap.md](./roadmap.md), R-19).

### Матричные тесты

[`src/test/matrix/`](../src/test/matrix/) — исполняемая версия
[odata-support.md](./odata-support.md). Таблицы «запрос → ожидаемые id» описывают
поддерживаемое подмножество OData, и **ожидания в них пишутся по спецификации, а не по
текущему поведению кода**: упавший тест — это заявка на доработку, а не повод подогнать
ожидание под реализацию.

Добавить оператор или функцию в матрицу — это одна строка:

```ts
{ name: 'mod', query: { $filter: 'age mod 2 eq 1' }, expected: [2, 3, 4] },
```

Фикстуры — `Author` / `Book` / `Review`: все категории типов колонок (строка, целое,
дробное, булево, дата-время, nullable-текст) и три уровня связей.

---

## Релиз

1. Убедиться, что `yarn lint && yarn test:unit && yarn build` проходят.
2. Проверить содержимое пакета: `npm pack --dry-run` (в CI это делает шаг
   «Check package contents»).
3. Поднять версию в `package.json`.
4. Закоммитить, поставить тег, запушить.
5. Создать GitHub Release — workflow `publish.yaml` соберёт и опубликует пакет автоматически.

Бета-версия — вручную: `yarn release:beta` (тег `beta` в npm).

---

## Куда смотреть дальше

| Документ | О чём |
|---|---|
| [architecture.md](./architecture.md) | Как устроен конвейер и почему именно так |
| [api.md](./api.md) | Справочник по всем экспортам |
| [odata-support.md](./odata-support.md) | Что из OData работает, а что нет |
| [audit.md](./audit.md) | Известные дефекты с воспроизведением |
| [roadmap.md](./roadmap.md) | План работ, задачи `R-NN` (на них ссылаются комментарии в коде) |
