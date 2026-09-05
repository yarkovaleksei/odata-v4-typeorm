/**
 * @file Подключение к базе для демо-сервера.
 *
 * SQLite в файле: демо должно запускаться одной командой, без поднятия внешней СУБД.
 * Файл базы пересоздаётся при каждом старте, поэтому данные всегда предсказуемы —
 * запросы из README и коллекции Postman возвращают ровно то, что в них описано.
 */
import * as path from 'path';

import { DataSource } from 'typeorm';

import { Author } from './entities/author';
import { Post } from './entities/post';
import { PostCategory } from './entities/postCategory';
import { PostComment } from './entities/postComment';
import { PostDetails } from './entities/postDetails';
import { User } from './entities/user';
import { SnakeCaseNamingStrategy } from './db/snakeCaseNamingStrategy';

/** Сущности демо: users → authors → posts → comments / category / details. */
export const entities = [User, Author, PostCategory, PostDetails, Post, PostComment];

export const dataSource = new DataSource({
  type: 'sqlite',
  database: process.env.DB_FILE ?? path.join(__dirname, '..', 'db.db'),
  entities,
  // Схема создаётся из декораторов; миграции демо не нужны, данные наливает seed.ts.
  synchronize: true,
  dropSchema: true,
  logging: process.env.DB_LOGGING === 'true',
  // Стратегия именования — snake_case: демонстрирует, что библиотека работает
  // и когда имена колонок в базе отличаются от имён свойств.
  namingStrategy: new SnakeCaseNamingStrategy(),
});
