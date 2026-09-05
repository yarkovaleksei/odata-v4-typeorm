/**
 * @file Средний уровень трёхуровневой связи `Author → Book → Review`.
 *
 * Нужен, чтобы проверить вложенный `$expand` (`$expand=books($expand=reviews)`) и рекурсию
 * в `processIncludes`: на двух уровнях дефекты именования алиасов ещё не проявляются,
 * на трёх — проявляются.
 *
 * `author` объявлен nullable, чтобы `LEFT JOIN` было чем отличить от `INNER`: в сидах есть
 * книга без автора, и она обязана попадать в выдачу при `$expand=author`.
 */
import { Column, Entity, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';

import { Author } from './Author.entity';
import { Review } from './Review.entity';

@Entity()
export class Book {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  title!: string;

  @Column('integer')
  pages!: number;

  @ManyToOne(() => Author, (author) => author.books)
  author!: Author | null;

  @OneToMany(() => Review, (review) => review.book)
  reviews!: Review[];
}
