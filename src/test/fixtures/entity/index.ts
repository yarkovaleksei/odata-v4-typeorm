/**
 * @file Единый набор сущностей для тестов и демо-сервера.
 *
 * ОДИН НАБОР НА ВСЁ. Раньше их было три: минимальный для базовых тестов, расширенный
 * для матрицы и отдельный у демо-сервера, плюс сущности, которые тесты объявляли прямо
 * в своём файле под конкретную проверку. Из-за этого демо показывало не то, что покрыто
 * тестами, а специальные случаи (скрытая колонка, представление без ключа) жили в стороне
 * от общей схемы и проверялись на самодельных подключениях.
 *
 * Предметная область — каталог книг с рецензиями:
 *
 * ```
 * Publisher ─┐
 * Category ──┼─→ Book ─→ Review ─→ User ─→ Post
 * Author ────┘    │ ↕
 *                 │ Tag (многие ко многим)
 *                 └─→ BookDetails (один к одному)
 * Category ─→ Category (ссылка на саму себя)
 * ```
 *
 * Что каким видом связи покрыто, расписано в комментариях {@link Book}.
 *
 * ЧТО НЕЛЬЗЯ МЕНЯТЬ, не тронув тесты: состав колонок {@link Author}, {@link Book},
 * {@link Review}, {@link User} и {@link Post} и значения фикстур в `seed.sql`.
 * На них стоят проверки выборки по умолчанию и таблицы матрицы, где ожидания записаны
 * идентификаторами строк. Новые типы колонок добавляйте в {@link Publisher}
 * и {@link BookDetails}.
 */
import { Author } from './Author.entity';
import { Book } from './Book.entity';
import { BookDetails } from './BookDetails.entity';
import { BookSummary } from './BookSummary.view';
import { Category } from './Category.entity';
import { Post } from './Post.entity';
import { Publisher } from './Publisher.entity';
import { Review } from './Review.entity';
import { Tag } from './Tag.entity';
import { User } from './User.entity';

export * from './Author.entity';
export * from './Book.entity';
export * from './BookDetails.entity';
export * from './BookSummary.view';
export * from './Category.entity';
export * from './Post.entity';
export * from './Publisher.entity';
export * from './Review.entity';
export * from './Tag.entity';
export * from './User.entity';

/**
 * Все сущности для `DataSource`.
 *
 * Порядок значения не имеет — TypeORM сам разбирает зависимости между связями.
 */
export const entities = [
  User,
  Post,
  Publisher,
  Category,
  Tag,
  Author,
  Book,
  BookDetails,
  Review,
  BookSummary,
];

/**
 * Таблицы в порядке, безопасном для удаления: сначала зависимые, потом главные.
 *
 * Нужен для очистки перед повторным наполнением там, где нет каскадов
 * (`clearDatabase` на SQLite). Представление сюда не входит — удалять в нём нечего.
 */
export const entitiesInDeletionOrder = [
  Review,
  BookDetails,
  Book,
  Tag,
  Category,
  Publisher,
  Author,
  Post,
  User,
];
