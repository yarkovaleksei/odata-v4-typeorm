/**
 * @file Тестовая сущность для матрицы совместимости с OData.
 *
 * В отличие от минимальных {@link User} / {@link Post}, здесь намеренно собраны все категории
 * типов, которые по-разному ведут себя при трансляции OData → SQL:
 *
 * | Поле           | Тип        | Что проверяет                                        |
 * |----------------|------------|------------------------------------------------------|
 * | `name`         | varchar    | строковые сравнения, `contains`, `$search` по тексту |
 * | `age`          | integer    | числовые сравнения, арифметика, `$search` по числам  |
 * | `rating`       | float      | дробные литералы, `round` / `floor` / `ceiling`      |
 * | `isActive`     | boolean    | булевы литералы `true` / `false`                     |
 * | `registeredAt` | datetime   | `year` / `month` / `day`, сравнение с датой-временем |
 * | `bio`          | text, null | `eq null` → `IS NULL`, `ne null` → `IS NOT NULL`     |
 *
 * Связь `books` даёт первый уровень `$expand`; через {@link Book} доступен и второй
 * (`$expand=books($expand=reviews)`).
 */
import { Column, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';

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

  @Column('boolean')
  isActive!: boolean;

  /** Nullable намеренно: единственный способ проверить `IS NULL` на дате. */
  @Column({ type: 'datetime', nullable: true })
  registeredAt!: Date | null;

  /** Nullable намеренно: проверка `bio eq null` / `bio ne null`. */
  @Column({ type: 'text', nullable: true })
  bio!: string | null;

  @OneToMany(() => Book, (book) => book.author)
  books!: Book[];
}
