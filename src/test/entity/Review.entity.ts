/**
 * @file Третий уровень связи `Author → Book → Review`.
 *
 * Существует ради вложенного `$expand` глубины 2 и фильтров по длинному пути
 * (`books/reviews/score`), где рекурсия `processIncludes` должна корректно передавать
 * алиас родителя вниз.
 */
import { Column, Entity, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { Book } from './Book.entity';

@Entity()
export class Review {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  text!: string;

  @Column('integer')
  score!: number;

  @ManyToOne(() => Book, (book) => book.reviews)
  book!: Book | null;
}
