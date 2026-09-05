/**
 * @file Сущности для тестов.
 *
 * Два независимых набора:
 * - {@link User} / {@link Post} — минимальный, для базовых тестов `executeQuery`;
 * - {@link Author} / {@link Book} / {@link Review} — расширенный, для матрицы совместимости
 *   с OData: все категории типов колонок и три уровня связей.
 *
 * Наборы не пересекаются намеренно: изменение фикстур матрицы не должно ломать базовые тесты.
 */
export * from './Author.entity';
export * from './Book.entity';
export * from './Post.entity';
export * from './Review.entity';
export * from './User.entity';
