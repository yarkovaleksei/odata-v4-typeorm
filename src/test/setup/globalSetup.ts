/**
 * @file Однократная подготовка схемы для внешних СУБД (`globalSetup` в `jest.config.js`).
 *
 * Jest запускает файлы тестов в отдельных воркерах, и каждый исполняет `setupFilesAfterEnv`
 * заново. Для SQLite это безобидно: `:memory:` даёт каждому подключению собственную базу.
 * Для PostgreSQL и MySQL база одна на всех, и параллельные `synchronize(true)` дерутся
 * за неё — прогон рассыпается на `duplicate key value violates unique constraint
 * "pg_type_typname_nsp_index"` и `relation "public.author" does not exist`.
 *
 * Поэтому схема создаётся здесь ровно один раз, до старта воркеров. Сами воркеры затем
 * только подключаются и пересоздают данные. Гонку за данными снимает `maxWorkers: 1`,
 * который `jest.config.js` включает для внешних СУБД.
 */
import { DataSource } from 'typeorm';

import { buildDataSourceOptions } from './dataSource';
import { testDatabase } from './testDatabase';

export default async function globalSetup(): Promise<void> {
  if (testDatabase === 'sqlite') {
    // База в памяти живёт внутри воркера; готовить нечего.
    return;
  }

  const dataSource = new DataSource(buildDataSourceOptions());

  await dataSource.initialize();

  try {
    // dropBeforeSync: прогон всегда начинается с чистой схемы, даже если контейнер
    // остался поднятым с прошлого раза и сущности с тех пор поменялись.
    await dataSource.synchronize(true);
  } finally {
    await dataSource.destroy();
  }
}
