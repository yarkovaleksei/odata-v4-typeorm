/**
 * @file Тестовая сущность «публикация» — обратная сторона связи с {@link User}.
 *
 * `user` объявлен nullable (`User | null`), чтобы можно было проверять преобразование
 * `$filter=user eq null` в SQL `IS NULL`. Колонка `content` имеет явный тип `text` —
 * он входит в белый список `searchableTextColumnTypes` и участвует в `$search`.
 */
import { Column, Entity, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { User } from './User.entity';

@Entity()
export class Post {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  title!: string;

  @Column('text')
  content!: string;

  @ManyToOne(() => User, (user) => user.posts)
  user!: User | null;
}
