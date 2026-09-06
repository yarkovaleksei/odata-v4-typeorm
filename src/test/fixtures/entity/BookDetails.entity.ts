/**
 * @file Выходные данные книги — владеющая сторона связи «один к одному».
 *
 * Владеющая, потому что `@JoinColumn` ставится ровно с одной стороны, и внешний ключ
 * логичнее держать здесь: книга существует и без выходных данных, обратное неверно.
 *
 * Колонка `releaseTime` — единственное место, где встречается тип `time`. Он нужен
 * функции `time()` из `$filter` и типу `Edm.TimeOfDay` в `$metadata`.
 */
import { Column, Entity, JoinColumn, OneToOne, PrimaryGeneratedColumn } from 'typeorm';

import { Book } from './Book.entity';

@Entity()
export class BookDetails {
  @PrimaryGeneratedColumn()
  id!: number;

  /** Номер ISBN-13 без дефисов; nullable — у старых изданий его нет. */
  @Column({ type: 'varchar', length: 13, nullable: true })
  isbn!: string | null;

  @Column({ type: 'text', nullable: true })
  summary!: string | null;

  /** Время выкладки тиража. Существует ради типа `time` и функции `time()` в `$filter`. */
  @Column({ type: 'time', nullable: true })
  releaseTime!: string | null;

  @OneToOne(() => Book, (book) => book.details)
  @JoinColumn()
  book!: Book | null;
}
