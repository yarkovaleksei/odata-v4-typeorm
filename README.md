# OData V4 Service modules - TYPEORM Connector

[![NPM](https://nodei.co/npm/odata-v4-typeorm-improved.png)](https://npmjs.org/package/odata-v4-typeorm-improved)

Service OData v4 requests from a TYPEORM.

## Synopsis

The OData V4 TYPEORM Connector provides functionality to convert the various types of OData segments
into SQL query statements, that you can execute over a TYPEORM.

## Potential usage scenarios

- Create high speed, standard compliant data sharing APIs

## Example server

The example server will automatically reflect the main project and automatically re-build on changes.
```bash
cd examples/server
yarn install
yarn serve
```

## Usage as server - TypeScript

Example request:
- GET [/api/users/$metadata](http://localhost:3001/api/users/$metadata)
- GET [/api/users?$search=user&$select=id,username](http://localhost:3001/api/users?$search=user&$select=id,username)

## NestJS middleware

##### middleware

```typescript
import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response } from 'express';
import { ODataQueryMiddleware } from 'odata-v4-typeorm-improved';
import { Repository } from 'typeorm';

import { UserEntity } from '../entities/user.entity';

@Injectable()
export class OdataUsersMiddleware implements NestMiddleware {
  constructor(
    @Inject('USERS_REPOSITORY') private readonly usersRepository: Repository<UserEntity>
  ) {}

  use(req: Request, res: Response, next: Function) {
    ODataQueryMiddleware(this.usersRepository)(req, res, next);
  }
}
```

##### users repository provider

```typescript
import { Connection } from 'typeorm';

import { UserEntity } from '../user.entity';

export const userProviders = [
  {
    provide: 'USERS_REPOSITORY',
    useFactory: (connection: Connection) => connection.getRepository(UserEntity),
    inject: ['DATABASE_CONNECTION'],
  }
];
```

##### database provider

```typescript
import { createConnection } from 'typeorm';

import { UserEntity } from '../entities/user.entity';

export const databaseProviders = [
  {
    provide: 'DATABASE_CONNECTION',
    useFactory: async () => await createConnection({
      type: 'postgres',
      host: 'localhost',
      port: 5432,
      username: 'postgres',
      password: 'root',
      database: 'test',
      synchronize: true,
      entities: [UserEntity]
    }),
  },
];
```

##### app module

```typescript
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';

import { databaseProviders } from './db/database.providers';
import { OdataUsersMiddleware } from './middlewares/odataUsers.middleware';
import { userProviders } from './providers/user.providers';

@Module({
  providers: [
    ...databaseProviders,
    ...userProviders,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(OdataUsersMiddleware)
      .forRoutes('api/v1/odata/users');
  }
}
```

## ODataQueryMiddleware

```typescript
import express from 'express';
import { ODataQueryMiddleware } from 'odata-v4-typeorm-improved';
import { getRepository } from 'typeorm';

import { User } from '../entities/user';

const app = express();
const usersRepository = getRepository(User);

app.get('/api/users', ODataQueryMiddleware(usersRepository));

const port = 3001;
app.listen(port, () => console.log(`Example app listening on port ${port}!`));
```

## executeQuery by repository

```typescript
import express from 'express';
import { executeQuery } from 'odata-v4-typeorm-improved';
import { getRepository } from 'typeorm';

import { User } from '../entities/user';

const app = express();

app.get('/api/users', async (req, res) => {
  try {
    const usersRepository = getRepository(User);
    const data = await executeQuery(usersRepository, req.query);
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({message: 'Internal server error.'});
  }
});

const port = 3001;
app.listen(port, () => console.log(`Example app listening on port ${port}!`));
```

## executeQuery by queryBuilder

```typescript
import express from 'express';
import { executeQuery } from 'odata-v4-typeorm-improved';
import { getRepository } from 'typeorm';

import { User } from '../entities/user';

const app = express();

app.get('/api/users', async (req, res) => {
  try {
    const queryBuilder = getRepository(User)
      .createQueryBuilder("user")
      .where("user.roleName = :roleName", { roleName: 'admin' });
    const data = await executeQuery(queryBuilder, req.query);
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({message: 'Internal server error.'});
  }
});

const port = 3001;
app.listen(port, () => console.log(`Example app listening on port ${port}!`));
```

## createFilter

```javascript
import { createFilter } from 'odata-v4-typeorm-improved'

//example request:  GET /api/Users?$filter=Id eq 42
app.get("/api/Users", (req: Request, res: Response) => {
    const filter = createFilter(req.query.$filter);
    // connection instance from pg module
    connection.query(`SELECT * FROM Users WHERE ${filter.where}`, filter.parameters, function(err, result){
        res.json({
        	'@odata.context': req.protocol + '://' + req.get('host') + '/api/$metadata#Users',
        	value: result.rows
        });
    });
});
```

Advanced TypeScript example available [here](https://raw.githubusercontent.com/yarkovaleksei/odata-v4-typeorm-improved/refs/heads/master/src/example/sql.ts).

## Usage ES5
```javascript
var createFilter = require('odata-v4-typeorm-improved').createFilter;

app.get("/api/Users", function(req, res) {
    var filter = createFilter(req.query.$filter);
    // connection instance from pg module
    connection.query(filter.from("Users"), filter.parameters, function(err, result){
        res.json({
        	'@odata.context': req.protocol + '://' + req.get('host') + '/api/$metadata#Users',
        	value: result.rows
        });
    });
})
```

## Supported OData segments

* $search
* $filter
* $orderby
* $select
* $expand
* $top
* $skip
* $count
