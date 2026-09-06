/**
 * @file Источник данных для интеграционных тестов.
 *
 * СУБД выбирается переменной окружения `TEST_DB`; по умолчанию — SQLite в памяти.
 * Так один и тот же набор тестов прогоняется на трёх диалектах:
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
 *
 * Сущности и данные — общие с демо-сервером, см. [src/test/fixtures/](../fixtures/).
 */
import { DataSource, type DataSourceOptions } from 'typeorm';

import { entities, SnakeCaseNamingStrategy, testDatabase } from '../fixtures';

export { clearDatabase, seedDatabase } from '../fixtures';
export { testDatabase, DATETIME_COLUMN_TYPE, type TestDatabase } from '../fixtures';

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
    // Обязательна: без неё имена колонок в базе остались бы camelCase, и общий
    // `seed.sql` перестал бы выполняться на PostgreSQL. Подробности — в namingStrategy.ts.
    namingStrategy: new SnakeCaseNamingStrategy(),
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
