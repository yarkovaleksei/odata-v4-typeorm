/**
 * @file Средний уровень трёхуровневой связи `Author → Book → Review` и узел,
 * в котором сходятся все виды связей TypeORM.
 *
 * | Связь | Вид | Зачем |
 * |---|---|---|
 * | `author` | «многие к одному», nullable | `LEFT JOIN` против `INNER`: книга без автора обязана попадать в выдачу при `$expand=author` |
 * | `publisher` | «многие к одному», обязательная | единственная связь с `Nullable="false"` в `$metadata` |
 * | `category` | «многие к одному», nullable | выход на сущность со ссылкой на саму себя |
 * | `reviews` | «один ко многим» | третий уровень вложенности и вложенная пагинация |
 * | `tags` | «многие ко многим» | таблица связи, которую `$metadata` обязан пропустить |
 * | `details` | «один к одному» | единственный случай, когда `$expand` даёт объект, а не массив и не ссылку |
 *
 * Состав колонок (`title`, `pages`) зафиксирован по той же причине, что и у {@link Author}:
 * на нём стоят проверки выборки по умолчанию.
 */
import {
  Column,
  Entity,
  JoinTable,
  ManyToMany,
  ManyToOne,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { Author } from './Author.entity';
import { BookDetails } from './BookDetails.entity';
import { Category } from './Category.entity';
import { Publisher } from './Publisher.entity';
import { Review } from './Review.entity';
import { Tag } from './Tag.entity';

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

  @ManyToOne(() => Publisher, (publisher) => publisher.books, { nullable: false })
  publisher!: Publisher;

  @ManyToOne(() => Category, (category) => category.books)
  category!: Category | null;

  @OneToMany(() => Review, (review) => review.book)
  reviews!: Review[];

  // Имя таблицы связи задано явно: значение по умолчанию (`book_tags_tag`) читается
  // в `seed.sql` хуже, а файл этот пишется и правится руками.
  @ManyToMany(() => Tag, (tag) => tag.books)
  @JoinTable({
    name: 'book_tag',
    joinColumn: { name: 'book_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'tag_id', referencedColumnName: 'id' },
  })
  tags!: Tag[];

  @OneToOne(() => BookDetails, (details) => details.book)
  details!: BookDetails | null;
}
