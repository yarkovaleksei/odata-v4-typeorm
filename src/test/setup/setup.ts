/**
 * @file Обвязка Jest, выполняемая в каждом воркере (`setupFilesAfterEnv` в `jest.config.js`).
 *
 * Файл выполняется в каждом тестовом окружении, поэтому хуки регистрируются для всех сьютов
 * сразу — включая чисто модульные, которым БД не нужна. Это осознанный размен: чуть более
 * медленный старт взамен на то, что в тестах не нужно помнить про инициализацию.
 */
import { clearDatabase, dataSource, seedDatabase, testDatabase } from './dataSource';

/**
 * Подключение к внешней БД поднимается дольше, чем SQLite в памяти. Пятнадцати секунд
 * хватает с запасом даже на холодный контейнер.
 */
if (testDatabase !== 'sqlite') {
  jest.setTimeout(15_000);
}

beforeAll(async () => {
  await dataSource.initialize();

  // Для SQLite схему создаём здесь: база `:memory:` принадлежит подключению, и того,
  // что сделал globalSetup в другом процессе, тут попросту нет.
  // Для внешних СУБД схема уже создана globalSetup — повторять нельзя, воркеры подрались бы.
  if (testDatabase === 'sqlite') {
    await dataSource.synchronize(true);
  }
});

afterAll(async () => {
  // Без destroy() открытое подключение удержит event loop и Jest завершится
  // предупреждением «open handles».
  await dataSource.destroy();
});

beforeEach(async () => {
  // Данные пересоздаются перед каждым тестом, поэтому порядок и независимость тестов
  // гарантированы даже при записи в БД.
  await clearDatabase(dataSource);
  await seedDatabase(dataSource);
});
