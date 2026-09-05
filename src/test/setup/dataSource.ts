/**
 * @file Источник данных для интеграционных тестов.
 *
 * SQLite в памяти выбран сознательно: тесты не требуют внешней БД, стартуют за доли секунды
 * и полностью изолированы друг от друга. Плата за это — часть поведения проверить нельзя:
 * диалектные различия SQL (`LEN` vs `LENGTH`, `NOW()`), цитирование идентификаторов
 * в MySQL и типы колонок, которых в SQLite нет.
 */
import * as fs from 'fs';
import { DataSource } from 'typeorm';

import { Author } from '../entity/Author.entity';
import { Book } from '../entity/Book.entity';
import { Post } from '../entity/Post.entity';
import { Review } from '../entity/Review.entity';
import { User } from '../entity/User.entity';

/**
 * Единый DataSource на весь прогон: поднимается один раз в `setup.ts`, схема пересоздаётся
 * перед каждым тестом. Держать его в модуле, а не создавать в каждом файле, обязательно —
 * иначе `:memory:` даст каждому подключению собственную пустую базу.
 */
export const dataSource = new DataSource({
  type: 'sqlite',
  database: ':memory:',
  // Схему строим из декораторов сущностей, миграции в тестах не нужны.
  synchronize: true,
  entities: [User, Post, Author, Book, Review],
  // Включите на время отладки, чтобы увидеть реальный SQL, который собрал QueryBuilder.
  logging: false,
});

/**
 * Выполняет .sql-файл как последовательность отдельных запросов.
 *
 * Драйвер SQLite умеет исполнять только один statement за вызов `query()`, поэтому файл
 * разбивается вручную. Разделитель — `;` в конце строки (`/;\s*\n/`), а не просто `;`:
 * так точка с запятой внутри строкового литерала не разрежет запрос пополам.
 * Разбиение остаётся наивным — для многострочных литералов и для `;` внутри триггеров
 * оно не годится, но для сидов вида INSERT его достаточно.
 *
 * @param filePath - абсолютный путь к .sql-файлу.
 */
export async function loadSqlFile(filePath: string) {
  const sql = fs.readFileSync(filePath, 'utf8');
  const queryRunner = dataSource.createQueryRunner();

  try {
    const statements = sql.split(/;\s*\n/).filter((stmt) => stmt.trim().length > 0);

    for (const statement of statements) {
      await queryRunner.query(statement);
    }
  } finally {
    // release() в finally: иначе упавший сид оставит подключение в пуле навсегда.
    await queryRunner.release();
  }
}
