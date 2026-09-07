/**
 * @file Подключение к базе для демо-сервера.
 *
 * SQLite в файле: демо должно запускаться одной командой, без поднятия внешней СУБД.
 * Файл базы пересоздаётся при каждом старте, поэтому данные всегда предсказуемы —
 * запросы из README и коллекции Postman возвращают ровно то, что в них описано.
 *
 * СУЩНОСТИ И ДАННЫЕ ОБЩИЕ С ТЕСТАМИ — [src/test/fixtures/](../../../src/test/fixtures/).
 * Раньше у демо был свой набор сущностей и свой сид, и показывало оно не то, что покрыто
 * тестами. Теперь запрос из конструктора, из коллекции Postman и из матрицы совместимости
 * работает с одной и той же схемой и одними и теми же строками.
 *
 * Путь до фикстур относительный, а не через `paths` из tsconfig: `paths` действует только
 * при проверке типов, а во время выполнения ts-node его не применяет. Саму библиотеку
 * демо подключает по её настоящему имени — это работает благодаря самоссылке пакета
 * (поле `exports` в корневом `package.json`) и ведёт в собранный `build/`.
 */
import * as path from 'path';

import { DataSource } from 'typeorm';

import { entities, SnakeCaseNamingStrategy } from '../../../src/test/fixtures';

export { entities };

export const dataSource = new DataSource({
  // Тот же драйвер, что и в тестах: в TypeORM 1.x драйвера `sqlite` больше нет.
  type: 'better-sqlite3',
  database: process.env.DB_FILE ?? path.join(__dirname, '..', 'db.db'),
  entities,
  // Схема создаётся из декораторов; миграции демо не нужны, данные наливает seed.sql.
  synchronize: true,
  dropSchema: true,
  logging: process.env.DB_LOGGING === 'true',
  // Та же стратегия, что и в тестах. Она обязательна для общего `seed.sql`:
  // без неё имена колонок остались бы camelCase и файл перестал бы быть переносимым.
  namingStrategy: new SnakeCaseNamingStrategy(),
});
