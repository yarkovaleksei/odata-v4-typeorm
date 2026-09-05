# Разработка

Всё, что нужно для работы над самим пакетом: команды, структура, отладка, релиз.

## Требования

| Инструмент | Версия | Примечание |
|---|---|---|
| Node.js | 20, 22 или 24 | CI прогоняет все три |
| Yarn | 1.x (classic) | Через Corepack; в проекте `yarn.lock` |
| TypeScript | 6.x | Из devDependencies, глобально ставить не нужно |

```bash
git clone https://github.com/yarkovaleksei/odata-v4-typeorm-improved.git
cd odata-v4-typeorm-improved
yarn install
```

---

## Команды

### Основные

| Команда | Что делает |
|---|---|
| `yarn test:unit` | Прогон всех тестов Jest |
| `yarn lint` | ESLint по всем `.ts` / `.tsx` |
| `yarn lint:fix` | То же с автоисправлением |
| `yarn build` | Чистая пересборка в `build/` (`rm -rf ./build && tsc -p tsconfig.build.json`) |
| `yarn server` | Поднять демо-сервер из `examples/server` с автоперезапуском |

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

Стоит запускать перед каждым релизом — сейчас в пакет попадают лишние файлы
([audit.md](./audit.md), дефект A-08):

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
yarn lint && yarn test:unit && yarn build
```

Ровно эту цепочку выполняет CI ([`ci.yaml`](../.github/workflows/ci.yaml)) на Node 20/22/24.

---

## Структура проекта

```
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
├── test/                    ← обвязка тестов (в пакет не идёт)
│   ├── entity/              сущности User и Post
│   └── setup/               DataSource на SQLite + seed.sql
└── example/                 ← пример без TypeORM (в пакет не идёт)

examples/server/             ← демо-сервер на Express
docs/                        ← эта документация
```

Соглашение по модулям: каталог на сущность, внутри `<name>.ts`, `<name>.test.ts`
и баррель `index.ts` с единственным `export * from './<name>'`.

---

## Тесты

### Как устроено

`jest.config.js` задаёт `rootDir: 'src'` и `setupFilesAfterEnv: ['./test/setup/setup.ts']`.
Обвязка поднимает SQLite в памяти один раз на прогон и **пересоздаёт схему перед каждым тестом**
(`synchronize(true)` + `seed.sql`), поэтому тесты независимы и порядок не важен.

Хуки регистрируются глобально — даже чисто модульные тесты стартуют с живым `DataSource`.

### Тестовые данные

`src/test/setup/seed.sql`:

| Таблица | Записи |
|---|---|
| `user` | Alice (id 1), Bob (id 2) |
| `post` | По две публикации на каждого пользователя |

Сущности — [`User`](../src/test/entity/User.entity.ts) и [`Post`](../src/test/entity/Post.entity.ts).
Связь один-ко-многим, `Post.user` — nullable (нужно для проверки `IS NULL`).

### Два стиля тестов

| Стиль | Где | Что проверяет |
|---|---|---|
| Модульные с моком QueryBuilder | `executeQueryByQueryBuilder.test.ts` | Факт и аргументы вызовов методов TypeORM |
| Интеграционные на реальной SQLite | `executeQuery.test.ts` | Итоговые данные из БД |

Перекос в сторону первых — известная проблема ([audit.md](./audit.md), Н-07): моки не ловят
дефекты генерации SQL. Новые тесты на поведение лучше писать интеграционными.

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

## Демо-сервер

```bash
yarn server
```

Эквивалент `cd examples/server && yarn install && yarn serve`. Сервер импортирует библиотеку
напрямую из `src/`, поэтому изменения подхватываются без пересборки (`nodemon` + `ts-node`).

Готовые запросы: коллекция и окружение Postman в
[`examples/postman/`](../examples/postman/).

> Пример написан на глобальном API TypeORM 0.2 (`getConnection` / `getRepository`),
> который в 0.3 объявлен устаревшим. Как образец кода для нового проекта его использовать
> не стоит — см. [roadmap.md](./roadmap.md), задача R-23.

---

## Стиль кода

- **ESLint 10**, flat config в [`eslint.config.ts`](../eslint.config.ts): рекомендованные наборы
  `@eslint/js` и `typescript-eslint` плюс `eslint-plugin-typeorm-typescript`
  (сверяет TS-типы полей с декораторами колонок).
- **Prettier** — конфиг [`.prettierrc`](../.prettierrc) есть (2 пробела, одинарные кавычки,
  точки с запятой, ширина 100), но сам пакет **не установлен** и в CI формат не проверяется
  ([audit.md](./audit.md), Н-06). Настройте форматирование в редакторе по этому конфигу.
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

---

## Релиз

1. Убедиться, что `yarn lint && yarn test:unit && yarn build` проходят.
2. Проверить содержимое пакета: `npm pack --dry-run`.
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
