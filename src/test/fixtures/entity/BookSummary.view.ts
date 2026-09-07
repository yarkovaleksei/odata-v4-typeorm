/**
 * @file Представление без первичного ключа.
 *
 * Единственное назначение — быть сущностью, которую нельзя опубликовать как набор OData:
 * `EntityType` в CSDL обязан иметь `Key`, а у представления его нет. Генератор `$metadata`
 * обязан такую сущность пропустить, а не выдать невалидную схему.
 *
 * Выражение намеренно простейшее и без кавычек: оно уходит в `CREATE VIEW` как есть,
 * то есть должно читаться и в SQLite, и в PostgreSQL, и в MySQL.
 */
import { ViewColumn, ViewEntity } from 'typeorm';

@ViewEntity({ expression: 'SELECT id, title, pages FROM book' })
export class BookSummary {
  @ViewColumn()
  id!: number;

  @ViewColumn()
  title!: string;

  @ViewColumn()
  pages!: number;
}
