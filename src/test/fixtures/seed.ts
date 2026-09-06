/**
 * @file Наполнение и очистка базы из общего файла `seed.sql`.
 *
 * Одним и тем же кодом пользуются тесты (перед каждым тестом) и демо-сервер (один раз
 * при старте), поэтому данные в демо и в тестах гарантированно совпадают: запрос из
 * README, из коллекции Postman и из матрицы вернёт одно и то же.
 *
 * Раньше данные наливались вставкой через репозитории. Так переносимее, но приходилось
 * держать две отдельные реализации — свою для тестов и свою для демо, — и они разошлись.
 * Файл SQL снимает эту проблему ценой нескольких правил оформления, перечисленных
 * в его заголовке.
 */
import * as fs from 'fs';
import * as path from 'path';

import type { DataSource } from 'typeorm';

import { testDatabase } from './database';
import { entitiesInDeletionOrder } from './entity';

/** Файл с данными. Лежит рядом; `__dirname` одинаково верен и под ts-node, и под ts-jest. */
const SEED_FILE = path.join(__dirname, 'seed.sql');

/** Разобранные команды. Файл не меняется по ходу прогона, читать его повторно незачем. */
let statements: string[] | undefined;

/**
 * Разбивает файл на отдельные команды.
 *
 * Драйверы MySQL и PostgreSQL по умолчанию не выполняют несколько команд в одном вызове,
 * поэтому файл приходится делить здесь. Разбор намеренно примитивный — построчное
 * снятие комментариев и разделение по `;`. Полноценный разбор SQL тут не нужен и был бы
 * источником собственных ошибок: файл пишется руками и подчиняется правилам из своего
 * заголовка, среди которых запрет на `;` и `--` внутри значений.
 */
function readStatements(): string[] {
  if (statements === undefined) {
    statements = fs
      .readFileSync(SEED_FILE, 'utf8')
      .split('\n')
      // Комментарии снимаются до отправки: они на русском, а кодировка соединения
      // с MySQL зависит от настроек сервера — данным незачем от этого зависеть.
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n')
      .split(';')
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
  }

  return statements;
}

/**
 * Таблицы в порядке, безопасном для удаления: сначала зависимые, потом главные.
 *
 * Таблицы связей берутся из метаданных, а не перечисляются руками: собственной сущности
 * у них нет, а очищать их надо раньше обеих сторон связи.
 */
function tablesToClear(dataSource: DataSource): string[] {
  const junctions = dataSource.entityMetadatas
    .filter((metadata) => metadata.isJunction)
    .map((metadata) => metadata.tableName);

  const tables = entitiesInDeletionOrder.map((entity) => dataSource.getMetadata(entity).tableName);

  return [...junctions, ...tables];
}

/** Выполняет `seed.sql` целиком. Схема должна быть уже создана. */
export async function seedDatabase(dataSource: DataSource): Promise<void> {
  for (const statement of readStatements()) {
    await dataSource.query(statement);
  }
}

/**
 * Очищает таблицы перед повторным наполнением.
 *
 * `synchronize(true)` для этого не годится: на PostgreSQL и MySQL пересоздание схемы перед
 * каждым из четырёхсот тестов занимает недопустимо много времени, тогда как на SQLite
 * в памяти оно было практически бесплатным.
 *
 * ГЛАВНОЕ ЗДЕСЬ — СБРОС СЧЁТЧИКОВ. Фикстуры задают идентификаторы явно, и ожидания
 * матрицы записаны этими же числами. Обычный `DELETE` счётчик автоинкремента не трогает,
 * поэтому на PostgreSQL повторная вставка пошла бы с других значений.
 */
export async function clearDatabase(dataSource: DataSource): Promise<void> {
  const tables = tablesToClear(dataSource).map((table) => dataSource.driver.escape(table));

  switch (testDatabase) {
    case 'postgres':
      // RESTART IDENTITY сбрасывает последовательности, CASCADE снимает вопрос порядка.
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
      // SQLite: удаляем от зависимых таблиц к главным, иначе внешние ключи не дадут
      // удалить родителя.
      for (const table of tables) {
        await dataSource.query(`DELETE FROM ${table}`);
      }

      // Таблица служебная и существует, только если хоть одна колонка объявлена AUTOINCREMENT.
      await dataSource.query('DELETE FROM sqlite_sequence').catch(() => undefined);
  }
}
