/**
 * @file Тестовая сущность «пользователь».
 *
 * Набор полей подобран под сценарии библиотеки: числовой первичный ключ (проверка числовой ветки
 * `$search` и фильтров по числам), два текстовых поля (текстовая ветка `$search`, `contains`)
 * и связь «один ко многим» (`$expand`, фильтры по пути `posts/title`).
 *
 * Имя класса `User` совпадает с алиасом, который передают тесты, — иначе
 * `connection.getMetadata(alias)` не найдёт метаданные (см. ограничение `alias` в `executeQuery`).
 */
import { Entity, PrimaryGeneratedColumn, Column, OneToMany } from 'typeorm';

import { Post } from './Post.entity';

@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  @Column({ unique: true })
  email!: string;

  @OneToMany(() => Post, (post) => post.user)
  posts!: Post[];
}
