/**
 * @file Пользователь: автор публикаций и рецензий.
 *
 * Таблица названа `app_user` явно, а не отдана стратегии именования: `user` —
 * зарезервированное слово в PostgreSQL, и в `seed.sql` некавыченный `INSERT INTO user`
 * не выполнился бы. На запросы OData имя таблицы не влияет — там участвует имя класса.
 *
 * `passwordHash` помечен `select: false` — это способ TypeORM сказать «колонка не покидает
 * сервер по умолчанию». Здесь он нужен как постоянная проверка дефекта A-12: библиотека
 * возвращала такие колонки в каждом ответе. Никакой тест не обязан заводить для этого
 * собственную сущность — достаточно запросить `User`.
 */
import { Column, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';

import { Post } from './Post.entity';
import { Review } from './Review.entity';

@Entity('app_user')
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  @Column({ unique: true })
  email!: string;

  /** Никогда не должен попадать в ответ — ни в выборке по умолчанию, ни через `$select`. */
  @Column({ select: false })
  passwordHash!: string;

  @OneToMany(() => Post, (post) => post.user)
  posts!: Post[];

  @OneToMany(() => Review, (review) => review.user)
  reviews!: Review[];
}
