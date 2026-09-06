/**
 * @file Раздел каталога — единственная сущность со ссылкой на саму себя.
 *
 * Нужна ради двух случаев, которых больше нигде нет: путь по связи, возвращающийся
 * к той же таблице (`$filter=parent/name eq 'Наука'`), и `$expand=children` —
 * там `processIncludes` обязан дать вложенному JOIN отдельный алиас, иначе SQL
 * сошлётся сам на себя.
 */
import { Column, Entity, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';

import { Book } from './Book.entity';

@Entity()
export class Category {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  /** Корневой раздел ссылается в никуда — отсюда nullable. */
  @ManyToOne(() => Category, (category) => category.children)
  parent!: Category | null;

  @OneToMany(() => Category, (category) => category.parent)
  children!: Category[];

  @OneToMany(() => Book, (book) => book.category)
  books!: Book[];
}
