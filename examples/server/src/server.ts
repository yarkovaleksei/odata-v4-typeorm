import express from 'express';
import { ODataQueryMiddleware } from '../../../src/lib';
import { getConnection, getRepository, type EntityTarget, type ObjectLiteral } from 'typeorm';

import { Author } from './entities/author';
import { Post } from './entities/post';
import { PostCategory } from './entities/postCategory';
import { PostDetails } from './entities/postDetails';

import { DataFilling1577087002356 } from './migrations/1577087002356-dataFilling';
import { createConnection } from './db/createConnection';
import config from './config';
import * as ormconfig from './ormconfig.json';
import { User } from './entities/user';
import { PostComment } from './entities/postComment';

function getMetadata(entity: EntityTarget<ObjectLiteral>) {
  const metadata = getConnection()
    .getMetadata(entity)
    .ownColumns.map((column) => {
      return {
        name: column.propertyName,
        type: typeof column.type === 'function' ? column.type.name : column.type,
        default: column.default,
        isNullable: column.isNullable,
      };
    });

  return metadata;
}

export default (async () => {
  try {
    const dbConfig = config.db;
    await createConnection(
      [Author, Post, PostCategory, PostDetails, PostComment, User],
      [DataFilling1577087002356],
      { ...dbConfig, ...ormconfig }
    );

    const app = express();

    // Posts
    const postsRepository = getRepository(Post);
    app.get('/api/posts/*$metadata', (res, req) => {
      return req.status(200).json(getMetadata(Post));
    });
    app.get('/api/posts', ODataQueryMiddleware(postsRepository));

    app.get('/api/posts/test', (res, req) => {
      const test = getConnection().getMetadata(Post);
      getRepository(Post)
        .createQueryBuilder('Post')
        // .andWhere('author23.id = :p0').setParameters({'p0': 1})
        .select(['Post.id', 'category33.id', 'document50.id'])

        .leftJoinAndSelect('Post.author', 'author8', '1 = 1')
        .leftJoinAndSelect('author8.document', 'document23', '1 = 1')
        .leftJoinAndSelect('Post.category', 'category33', '1 = 1')
        .leftJoin('category33.document', 'document50', '1 = 1')

        .getMany()
        .then((data) => {
          req.status(200).json(data);
        });
    });

    // Authors
    const authorsRepository = getRepository(Author);
    app.get('/api/authors/*$metadata', (res, req) => {
      return req.status(200).json(getMetadata(Author));
    });
    app.get('/api/authors', ODataQueryMiddleware(authorsRepository));

    // Users
    const usersRepository = getRepository(User);
    app.get('/api/users/*$metadata', (res, req) => {
      return req.status(200).json(getMetadata(User));
    });
    app.get('/api/users', ODataQueryMiddleware(usersRepository));

    const port = config.http.port;
    app.listen(port, () => console.log(`Example app listening on port ${port}!`));
  } catch (e) {
    console.error(e, 'Start service error');
  }
})();
