/**
 * @file Издательство — сторона «один» для {@link Book}.
 *
 * Здесь собраны типы колонок, которых нет у остальных сущностей: `varchar` с длиной,
 * `decimal` с точностью и масштабом, `date` без времени. Они нужны не запросам,
 * а описанию схемы: именно из них `$metadata` берёт атрибуты `MaxLength`,
 * `Precision` и `Scale`, а `resolveEdmType` — типы `Edm.Decimal` и `Edm.Date`.
 *
 * Ставить их на {@link Author} или {@link Book} было нельзя: те участвуют в матрице
 * совместимости, и лишняя колонка изменила бы состав выборки по умолчанию сразу
 * в нескольких десятках проверок.
 */
import { Column, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';

import { Book } from './Book.entity';

@Entity()
export class Publisher {
  /**
   * Первичный ключ — UUID, а не счётчик: в реальных приложениях так чаще, и путь
   * «строковый ключ» обязан быть проверен наравне с числовым.
   *
   * Физическую колонку TypeORM подбирает под драйвер: в PostgreSQL это настоящий `uuid`,
   * в MySQL и SQLite — `varchar(36)`, потому что типа `uuid` там нет. В метаданных при
   * этом остаётся объявленный тип, поэтому `$metadata` описывает ключ одинаково
   * (`Edm.Guid`) на любой СУБД, а `$search` не трогает его ни на одной: `uuid` не входит
   * в список текстовых типов.
   */
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 120 })
  name!: string;

  /** Код страны по ISO 3166-1 alpha-2. */
  @Column({ type: 'varchar', length: 2 })
  country!: string;

  @Column({ type: 'date' })
  foundedOn!: string;

  /**
   * Тип объявлен `string`, а не `number`: драйверы PostgreSQL и MySQL возвращают
   * `decimal` строкой, чтобы не терять точность при переводе в double.
   */
  @Column({ type: 'decimal', precision: 10, scale: 2 })
  royaltyRate!: string;

  @OneToMany(() => Book, (book) => book.publisher)
  books!: Book[];
}
