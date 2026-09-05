/**
 * @file Источник данных для интеграционных тестов.
 *
 * СУБД выбирается переменной окружения `TEST_DB`; по умолчанию — SQLite в памяти.
 * Так один и тот же набор матричных тестов прогоняется на четырёх диалектах:
 *
 * ```bash
 * yarn test:unit                    # sqlite, ничего поднимать не нужно
 * yarn db:up && TEST_DB=postgres yarn test:unit
 * yarn db:up && TEST_DB=mysql yarn test:unit
 * ```
 *
 * ЗАЧЕМ. Трансляция функций OData зависит от диалекта (`LENGTH` против `LEN`, `EXTRACT`
 * против `strftime`, `||` против `CONCAT`). Юнит-тесты проверяют вид сгенерированного SQL,
 * но не то, что СУБД его примет: строка `EXTRACT(YEAR FROM …)` может выглядеть правильно
 * и при этом не выполниться. Отличить одно от другого умеет только настоящая база.
 */
import { DataSource, type DataSourceOptions } from 'typeorm';

import { Author } from '../entity/Author.entity';
import { Book } from '../entity/Book.entity';
import { Post } from '../entity/Post.entity';
import { Review } from '../entity/Review.entity';
import { User } from '../entity/User.entity';
import { testDatabase } from './testDatabase';

export { testDatabase, type TestDatabase } from './testDatabase';

/** Сущности тестового набора; порядок важен только для читаемости. */
const entities = [User, Post, Author, Book, Review];

/** Адрес базы по умолчанию для каждой внешней СУБД: порты проброса из `compose.yaml`. */
const DEFAULT_ENDPOINTS = {
  postgres: { host: '127.0.0.1', port: 55432 },
  mysql: { host: '127.0.0.1', port: 53306 },
} as const;

/**
 * Адрес и учётные данные внешней СУБД.
 *
 * Три уровня приоритета, от высшего к низшему:
 *
 * 1. `TEST_DB_HOST` / `TEST_DB_PORT` — разовое переопределение для конкретного прогона;
 * 2. `TEST_POSTGRES_HOST` / `TEST_MYSQL_PORT` и т.п. — адреса обеих баз сразу. Нужны,
 *    когда одна команда прогоняет матрицу на нескольких СУБД (`yarn test:all`): единой
 *    пары «хост-порт» там не существует, а внутри сети compose адреса отличаются
 *    от проброшенных на хост;
 * 3. значения из {@link DEFAULT_ENDPOINTS} — работа с локально поднятым `compose.yaml`.
 */
function resolveConnection(database: 'postgres' | 'mysql') {
  const prefix = database === 'postgres' ? 'TEST_POSTGRES' : 'TEST_MYSQL';
  const defaults = DEFAULT_ENDPOINTS[database];

  return {
    host: process.env.TEST_DB_HOST ?? process.env[`${prefix}_HOST`] ?? defaults.host,
    port: Number(process.env.TEST_DB_PORT ?? process.env[`${prefix}_PORT`] ?? defaults.port),
    username: process.env.TEST_DB_USER ?? 'odata',
    password: process.env.TEST_DB_PASSWORD ?? 'odata',
    database: process.env.TEST_DB_NAME ?? 'odata_test',
  };
}

/**
 * Параметры подключения под выбранную СУБД.
 *
 * Экспортируется, потому что этими же параметрами пользуется `globalSetup.ts`:
 * он создаёт схему до старта воркеров, отдельным подключением.
 */
export function buildDataSourceOptions(): DataSourceOptions {
  const shared = {
    entities,
    // Схему строим из декораторов сущностей, миграции в тестах не нужны.
    synchronize: true,
    // Включите на время отладки, чтобы увидеть реальный SQL, который собрал QueryBuilder.
    logging: false,
  } as const;

  switch (testDatabase) {
    case 'postgres':
      return { ...shared, type: 'postgres', ...resolveConnection('postgres') };

    case 'mysql':
      return { ...shared, type: 'mysql', ...resolveConnection('mysql') };

    default:
      return { ...shared, type: 'sqlite', database: ':memory:' };
  }
}

/**
 * Единый DataSource на весь прогон: поднимается один раз в `setup.ts`.
 *
 * Держать его в модуле, а не создавать в каждом файле, обязательно — для SQLite `:memory:`
 * каждое новое подключение получило бы собственную пустую базу.
 */
export const dataSource = new DataSource(buildDataSourceOptions());

/**
 * Наполняет базу тестовыми данными.
 *
 * Раньше сиды лежали в `seed.sql` и выполнялись как сырой SQL. Для прогона на нескольких
 * СУБД это не годится: идентификаторы в кавычках `"user"` MySQL по умолчанию считает
 * строковым литералом, а `user` — зарезервированное слово. Вставка через репозитории
 * переносима: TypeORM сам экранирует имена под конкретный драйвер.
 *
 * Значения подобраны так, чтобы каждый оператор давал непустую и при этом НЕ полную
 * выборку — иначе тест не отличит работающий фильтр от отброшенного.
 */
export async function seedDatabase(): Promise<void> {
  await dataSource.getRepository(User).save([
    { id: 1, name: 'Alice', email: 'alice@example.com' },
    { id: 2, name: 'Bob', email: 'bob@example.com' },
  ]);

  await dataSource.getRepository(Post).save([
    { id: 1, title: 'Alice first post', content: 'First post of Alice', user: { id: 1 } },
    { id: 2, title: 'Alice second post', content: 'Second post of Alice', user: { id: 1 } },
    { id: 3, title: 'Bob first post', content: 'First post of Bob', user: { id: 2 } },
    { id: 4, title: 'Bob second post', content: 'Second post of Bob', user: { id: 2 } },
  ]);

  //   id  name      age  rating  isActive  registeredAt         bio
  //   1   Ada       36   4.25    true      2020-01-15 10:30:00  'Pioneer of computing'
  //   2   Grace     45   4.9     true      2021-06-01 08:00:00  NULL
  //   3   Alan      41   3.2     false     NULL                 'Codebreaker'
  //   4   Barbara   29   4.25    true      2022-03-20 12:00:00  NULL
  //
  // ПРО ДАТЫ. Прогон идёт в UTC (`process.env.TZ` в `jest.config.js`), поэтому локальные
  // составляющие совпадают с UTC. Это принципиально: колонка объявлена без часового пояса,
  // но драйверы обращаются с ней по-разному — SQLite сохраняет момент в UTC, PostgreSQL
  // пишет локальные составляющие. Без общей зоны `hour(registeredAt) eq 8` давал бы
  // разный результат на разных СУБД.
  //
  // ПРО ДРОБНЫЕ. Значения намеренно без «половинок»: округление ровно 4.5 у СУБД разное —
  // SQLite округляет от нуля (5), PostgreSQL для float8 применяет банковское (4).
  await dataSource.getRepository(Author).save([
    {
      id: 1,
      name: 'Ada',
      age: 36,
      rating: 4.25,
      isActive: true,
      registeredAt: new Date(2020, 0, 15, 10, 30, 0),
      bio: 'Pioneer of computing',
    },
    {
      id: 2,
      name: 'Grace',
      age: 45,
      rating: 4.9,
      isActive: true,
      registeredAt: new Date(2021, 5, 1, 8, 0, 0),
      bio: null,
    },
    { id: 3, name: 'Alan', age: 41, rating: 3.2, isActive: false, registeredAt: null, bio: 'Codebreaker' },
    {
      id: 4,
      name: 'Barbara',
      age: 29,
      rating: 4.25,
      isActive: true,
      registeredAt: new Date(2022, 2, 20, 12, 0, 0),
      bio: null,
    },
  ]);

  // Книга 5 намеренно без автора: проверяет, что $expand делает LEFT JOIN, а не INNER.
  await dataSource.getRepository(Book).save([
    { id: 1, title: 'Analytical Engine', pages: 300, author: { id: 1 } },
    { id: 2, title: 'Notes on Numbers', pages: 120, author: { id: 1 } },
    { id: 3, title: 'Compiler Theory', pages: 450, author: { id: 2 } },
    { id: 4, title: 'Enigma Machines', pages: 210, author: { id: 3 } },
    { id: 5, title: 'Orphan Book', pages: 90, author: null },
  ]);

  await dataSource.getRepository(Review).save([
    { id: 1, text: 'Brilliant work', score: 5, book: { id: 1 } },
    { id: 2, text: 'Hard but worth it', score: 4, book: { id: 1 } },
    { id: 3, text: 'Concise', score: 3, book: { id: 2 } },
    { id: 4, text: 'Foundational', score: 5, book: { id: 3 } },
    { id: 5, text: 'Dry', score: 2, book: { id: 4 } },
  ]);
}

/**
 * Очищает таблицы перед повторным наполнением.
 *
 * `synchronize(true)` для этого не годится: на PostgreSQL и MySQL пересоздание схемы перед
 * каждым из трёхсот тестов занимает недопустимо много времени, тогда как на SQLite в памяти
 * оно было практически бесплатным.
 *
 * ГЛАВНОЕ ЗДЕСЬ — СБРОС СЧЁТЧИКОВ. Фикстуры задают идентификаторы явно (`id: 1`), и ожидания
 * матрицы записаны этими же числами. Но `@PrimaryGeneratedColumn()` означает, что значение
 * назначает база: явно переданный id при вставке игнорируется. Обычный `DELETE` счётчик
 * не трогает, поэтому на PostgreSQL второй прогон сида выдавал уже `3, 4` вместо `1, 2` —
 * и вставка связанных строк падала на внешнем ключе.
 *
 * На SQLite это не проявлялось: там идентификаторы переиспользуются после удаления,
 * и совпадение получалось случайно.
 */
export async function clearDatabase(): Promise<void> {
  const tables = [Review, Book, Author, Post, User].map((entity) =>
    dataSource.driver.escape(dataSource.getMetadata(entity).tableName)
  );

  switch (testDatabase) {
    case 'postgres':
      // RESTART IDENTITY сбрасывает последовательности, CASCADE снимает вопрос порядка таблиц.
      await dataSource.query(`TRUNCATE TABLE ${tables.join(', ')} RESTART IDENTITY CASCADE`);

      return;

    case 'mysql':
      // TRUNCATE в MySQL сбрасывает AUTO_INCREMENT, но не выполняется при живых внешних
      // ключах — на время очистки проверку приходится снимать.
      await dataSource.query('SET FOREIGN_KEY_CHECKS = 0');

      try {
        for (const table of tables) {
          await dataSource.query(`TRUNCATE TABLE ${table}`);
        }
      } finally {
        await dataSource.query('SET FOREIGN_KEY_CHECKS = 1');
      }

      return;

    default:
      // SQLite: удаляем от зависимых сущностей к главным, иначе внешние ключи не дадут
      // удалить родителя.
      for (const entity of [Review, Book, Author, Post, User]) {
        await dataSource.getRepository(entity).createQueryBuilder().delete().execute();
      }

      // Таблица служебная и существует, только если хоть одна колонка объявлена AUTOINCREMENT.
      await dataSource.query('DELETE FROM sqlite_sequence').catch(() => undefined);
  }
}
