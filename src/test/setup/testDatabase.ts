/**
 * @file Выбор СУБД для прогона тестов.
 *
 * Вынесено в отдельный модуль, потому что значение нужно и `dataSource.ts` (там строятся
 * параметры подключения), и самим сущностям (там от диалекта зависит тип колонки с датой).
 * Держать его в `dataSource.ts` нельзя — тот импортирует сущности, получилось бы кольцо.
 */

/** Какая СУБД используется в текущем прогоне. */
export type TestDatabase = 'sqlite' | 'postgres' | 'mysql';

/**
 * Целевая СУБД прогона; задаётся переменной окружения `TEST_DB`.
 *
 * @defaultValue `'sqlite'` — не требует ничего поднимать
 */
export const testDatabase: TestDatabase = (process.env.TEST_DB as TestDatabase) || 'sqlite';

/**
 * Имя типа для колонки с датой и временем.
 *
 * Единого типа, который понимают все три СУБД, не существует: `datetime` есть в MySQL
 * и SQLite, но не в PostgreSQL; `timestamp` — в PostgreSQL и MySQL, но не в SQLite.
 * Поэтому тип выбирается по диалекту.
 *
 * Для ненулевых полей проще положиться на вывод типа из TypeScript (`@Column()` над полем
 * типа `Date`) — TypeORM сам подберёт нужный тип. Но у nullable-поля тип в TS выглядит как
 * `Date | null`, метаданные декоратора дают `Object`, и вывод не срабатывает.
 */
export const DATETIME_COLUMN_TYPE = testDatabase === 'postgres' ? 'timestamp' : 'datetime';
