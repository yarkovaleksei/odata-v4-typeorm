/**
 * @file Стратегия именования snake_case для фикстур.
 *
 * ЗАЧЕМ ОНА ОБЯЗАТЕЛЬНА, а не просто желательна. Данные наливаются одним файлом
 * `seed.sql` на все три СУБД, а значит все идентификаторы в нём должны читаться
 * без кавычек: PostgreSQL приводит некавыченный идентификатор к нижнему регистру,
 * поэтому `INSERT INTO author (registeredAt)` не найдёт колонку `registeredAt`,
 * созданную TypeORM. Кавычки положение не спасают — `"registeredAt"` работает
 * в PostgreSQL и SQLite, но не в MySQL, где кавычки означают строку.
 *
 * Всё в нижнем регистре и через подчёркивание — единственная форма, одинаково
 * понятная всем трём.
 *
 * ПОБОЧНАЯ ВЫГОДА. Имена колонок в базе перестают совпадать с именами свойств,
 * и весь набор тестов начинает проверять этот разрыв постоянно, а не в одном
 * специальном случае. Именно на нём ломался `$search`: он собирал условие
 * из `propertyName` вместо `databaseName` (см. `docs/audit.md`, дефект A-05).
 */
import { DefaultNamingStrategy, type NamingStrategyInterface } from 'typeorm';

/** `registeredAt` → `registered_at`, `ISBNCode` → `isbn_code`. */
function snakeCase(value: string): string {
  return value
    .replace(/(?:([a-z0-9])([A-Z]))|(?:((?!^)[A-Z])([a-z]))/g, '$1_$3$2$4')
    .toLowerCase();
}

/**
 * Полная snake_case-стратегия: таблицы, колонки, колонки внешних ключей и таблицы связей.
 *
 * Переопределять только `tableName` и `columnName` недостаточно — TypeORM именует
 * колонки внешних ключей отдельным методом, и без него связь `author` дала бы колонку
 * `authorId` посреди snake_case-схемы. В `seed.sql` такая колонка снова стала бы
 * непереносимой.
 */
export class SnakeCaseNamingStrategy
  extends DefaultNamingStrategy
  implements NamingStrategyInterface
{
  override tableName(targetName: string, userSpecifiedName: string | undefined): string {
    return userSpecifiedName ?? snakeCase(targetName);
  }

  override columnName(
    propertyName: string,
    customName: string | undefined,
    embeddedPrefixes: string[]
  ): string {
    return snakeCase(embeddedPrefixes.concat(customName ?? propertyName).join('_'));
  }

  override relationName(propertyName: string): string {
    return snakeCase(propertyName);
  }

  /** Связь `author` на ключ `id` → колонка `author_id`. */
  override joinColumnName(relationName: string, referencedColumnName: string): string {
    return snakeCase(`${relationName}_${referencedColumnName}`);
  }

  /** Таблица связи «многие ко многим»: `book` + `tags` + `tag` → `book_tags_tag`. */
  override joinTableName(
    firstTableName: string,
    secondTableName: string,
    firstPropertyName: string
  ): string {
    return snakeCase(
      `${firstTableName}_${firstPropertyName.replace(/\./gi, '_')}_${secondTableName}`
    );
  }

  override joinTableColumnName(
    tableName: string,
    propertyName: string,
    columnName?: string
  ): string {
    return snakeCase(`${tableName}_${columnName ?? propertyName}`);
  }
}
