/**
 * @file Основная сущность матрицы совместимости с OData.
 *
 * Здесь намеренно собраны все категории типов, которые по-разному ведут себя
 * при трансляции OData → SQL:
 *
 * | Поле           | Тип        | Что проверяет                                        |
 * |----------------|------------|------------------------------------------------------|
 * | `name`         | varchar    | строковые сравнения, `contains`, `$search` по тексту |
 * | `age`          | integer    | числовые сравнения, арифметика, `$search` по числам  |
 * | `rating`       | float      | дробные литералы, `round` / `floor` / `ceiling`      |
 * | `isActive`     | boolean    | булевы литералы `true` / `false`                     |
 * | `registeredAt` | дата-время | `year` / `month` / `day`, сравнение с датой-временем |
 * | `bio`          | text, null | `eq null` → `IS NULL`, `ne null` → `IS NOT NULL`     |
 *
 * Состав колонок зафиксирован: на нём стоят десятки проверок матрицы, которые сверяют
 * выборку по умолчанию. Новые типы колонок добавляются в {@link Publisher}
 * и {@link BookDetails}, а не сюда.
 *
 * Связь `books` даёт первый уровень `$expand`; через {@link Book} доступен и второй
 * (`$expand=books($expand=reviews)`).
 */
import { Column, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';

import { DATETIME_COLUMN_TYPE } from '../database';
import { Book } from './Book.entity';

@Entity()
export class Author {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  @Column('integer')
  age!: number;

  @Column('float')
  rating!: number;

  // Тип не указан намеренно: TypeORM выведет его из TypeScript и подберёт под драйвер
  // (`boolean` в PostgreSQL и SQLite, `tinyint` в MySQL) — единого имени типа для всех трёх нет.
  @Column()
  isActive!: boolean;

  /**
   * Nullable намеренно: единственный способ проверить `IS NULL` на дате.
   *
   * Тип берётся из {@link DATETIME_COLUMN_TYPE}: `datetime` понимают MySQL и SQLite,
   * `timestamp` — PostgreSQL и MySQL, общего для всех трёх нет.
   */
  @Column({ type: DATETIME_COLUMN_TYPE, nullable: true })
  registeredAt!: Date | null;

  /** Nullable намеренно: проверка `bio eq null` / `bio ne null`. */
  @Column({ type: 'text', nullable: true })
  bio!: string | null;

  @OneToMany(() => Book, (book) => book.author)
  books!: Book[];
}
