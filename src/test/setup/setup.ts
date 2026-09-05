/**
 * @file Глобальная обвязка Jest (`setupFilesAfterEnv` в `jest.config.js`).
 *
 * Файл выполняется в каждом тестовом окружении, поэтому хуки регистрируются для всех сьютов сразу —
 * включая чисто модульные, которым БД не нужна. Это осознанный размен: чуть более медленный старт
 * взамен на то, что в тестах не нужно помнить про инициализацию.
 */
import * as path from 'path';

import { dataSource, loadSqlFile } from './dataSource';

beforeAll(async () => {
  await dataSource.initialize();
});

afterAll(async () => {
  // Без destroy() открытое подключение удержит event loop и Jest завершится
  // предупреждением «open handles».
  await dataSource.destroy();
});

beforeEach(async () => {
  // synchronize(true) = dropSchema + create: каждый тест стартует на чистой схеме,
  // поэтому порядок и независимость тестов гарантированы даже при записи в БД.
  await dataSource.synchronize(true);

  const filePath = path.join(__dirname, 'seed.sql');

  await loadSqlFile(filePath);
});
