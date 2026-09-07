/**
 * @file Метка книги — обратная сторона единственной связи «многие ко многим».
 *
 * Связь с {@link Book} даёт то, чего не даёт ни одна другая: таблицу связи, для которой
 * TypeORM заводит собственные метаданные. Она не является самостоятельной сущностью,
 * и `$metadata` обязан её пропустить.
 */
import { Column, Entity, ManyToMany, PrimaryGeneratedColumn } from 'typeorm';

import { Book } from './Book.entity';

@Entity()
export class Tag {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  label!: string;

  @ManyToMany(() => Book, (book) => book.tags)
  books!: Book[];
}
