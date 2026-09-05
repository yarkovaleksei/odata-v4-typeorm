/**
 * @file Наполнение демо-базы.
 *
 * Раньше данные наливались миграцией сырым SQL с явными идентификаторами. Для демо это
 * лишняя сложность: миграции нужны там, где схема эволюционирует, а здесь она создаётся
 * заново при каждом старте. Вставка через репозитории короче и не зависит от диалекта.
 *
 * Значения подобраны так, чтобы примеры запросов давали непустой и при этом не полный
 * результат — иначе на демо не видно, работает фильтр или нет.
 */
import type { DeepPartial } from 'typeorm';

import { dataSource } from './dataSource';
import { Author } from './entities/author';
import { Post } from './entities/post';
import { PostCategory } from './entities/postCategory';
import { PostComment } from './entities/postComment';
import { PostDetails } from './entities/postDetails';
import { User } from './entities/user';

export async function seed(): Promise<void> {
  const users = await dataSource.getRepository(User).save([
    { username: 'a_manning_ursula' },
    { username: 'a_butler_carly' },
    { username: 'a_juarez_maggy' },
    { username: 'a_murray_colette' },
    { username: 'a_salinas_emmanuel' },
  ]);

  const authors = await dataSource.getRepository(Author).save([
    { name: 'Ursula Manning', user: users[0] },
    { name: 'Carly Butler', user: users[1] },
    { name: 'Maggy Juarez', user: users[2] },
    { name: 'Colette Murray', user: users[3] },
    { name: 'Emmanuel Salinas', user: users[4] },
  ]);

  const categories = await dataSource.getRepository(PostCategory).save([
    { name: 'Databases' },
    { name: 'TypeScript' },
    { name: 'Architecture' },
    { name: 'Testing' },
  ]);

  const details = await dataSource.getRepository(PostDetails).save([
    { authorName: 'Ursula Manning', comment: 'Черновик', metadata: 'draft' },
    { authorName: 'Carly Butler', comment: null, metadata: 'published' },
    { authorName: 'Maggy Juarez', comment: 'Требует правок', metadata: 'review' },
  ]);

  // Тип указан явно: без него вывод спотыкается о разнородные объекты — часть постов
  // идёт с `details`, часть без.
  const postsToSave: DeepPartial<Post>[] = [
    { title: 'Индексы в PostgreSQL', text: 'Когда B-tree проигрывает GIN', category: categories[0], author: authors[0], details: details[0] },
    { title: 'Строгий режим TypeScript', text: 'Что находит strictNullChecks', category: categories[1], author: authors[1], details: details[1] },
    { title: 'Слои приложения', text: 'Границы между доменом и транспортом', category: categories[2], author: authors[2], details: details[2] },
    { title: 'Тесты на реальной БД', text: 'Чего не видят моки', category: categories[3], author: authors[0] },
    { title: 'Планировщик запросов', text: 'Как читать EXPLAIN ANALYZE', category: categories[0], author: authors[3] },
    { title: 'Дженерики без боли', text: 'Вывод типов и его пределы', category: categories[1], author: authors[4] },
  ];

  const posts = await dataSource.getRepository(Post).save(postsToSave);

  const commentsToSave: DeepPartial<PostComment>[] = [
    { comment: 'Отличный разбор', user: users[1], post: posts[0] },
    { comment: 'Не хватило примеров', user: users[2], post: posts[0] },
    // Пустой комментарий — чтобы на демо работал фильтр `comment eq null`.
    { comment: null, user: users[3], post: posts[1] },
    { comment: 'Согласен по всем пунктам', user: users[0], post: posts[2] },
    { comment: 'Спорно', user: users[4], post: posts[4] },
  ];

  await dataSource.getRepository(PostComment).save(commentsToSave);
}
