/**
 * @file Третий уровень связи `Author → Book → Review`.
 *
 * Существует ради вложенного `$expand` глубины 2 и фильтров по длинному пути
 * (`books/reviews/score`), где рекурсия `processIncludes` должна корректно передавать
 * алиас родителя вниз.
 *
 * Связь `user` замыкает граф: от рецензии есть путь и к книге, и к пользователю,
 * то есть у сущности больше одной ветки `$expand`.
 */
import { Column, Entity, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { Book } from './Book.entity';
import { User } from './User.entity';

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

  @ManyToOne(() => User, (user) => user.reviews)
  user!: User | null;
}
