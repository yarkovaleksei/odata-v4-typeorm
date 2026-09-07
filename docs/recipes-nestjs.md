# Рецепты: NestJS

Подключение библиотеки к приложению на NestJS. Рецепты, не зависящие от фреймворка
(опции запроса, форма ответа, `$search`, лямбды, компиляция без TypeORM), —
в [recipes.md](./recipes.md); для чистого Express есть
[recipes-express.md](./recipes-express.md).

Ключевое для NestJS: `executeQuery` и `createMetadataDocument` про HTTP ничего не знают —
им нужен объект параметров и `DataSource`. Поэтому основной способ подключения здесь —
обычный контроллер, а не middleware: он работает на любом адаптере и пропускает ответ
через пайплайн Nest (интерцепторы, фильтры исключений, сериализацию).

Готовые `ODataQueryMiddleware` и `ODataMetadataMiddleware` написаны под сигнатуру Express
`(req, res, next)` и годятся только для платформы `@nestjs/platform-express` —
[см. ниже](#middleware-вместо-контроллера).

---

## Подключение TypeORM

### Через `@nestjs/typeorm`

```ts
// app.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { UserEntity } from './entities/user.entity';
import { UsersController } from './users/users.controller';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: 'localhost',
      port: 5432,
      username: 'postgres',
      password: 'postgres',
      database: 'app',
      entities: [UserEntity],
    }),
    TypeOrmModule.forFeature([UserEntity]),
  ],
  controllers: [UsersController],
})
export class AppModule {}
```

### Ручные провайдеры, без `@nestjs/typeorm`

```ts
// database.providers.ts
import { DataSource } from 'typeorm';

import { UserEntity } from '../entities/user.entity';

export const databaseProviders = [
  {
    provide: 'DATA_SOURCE',
    useFactory: async () => {
      const dataSource = new DataSource({
        type: 'postgres',
        host: 'localhost',
        port: 5432,
        username: 'postgres',
        password: 'postgres',
        database: 'app',
        entities: [UserEntity],
      });

      return dataSource.initialize();
    },
  },
];
```

```ts
// user.providers.ts
import { DataSource } from 'typeorm';

import { UserEntity } from '../entities/user.entity';

export const userProviders = [
  {
    provide: 'USERS_REPOSITORY',
    useFactory: (dataSource: DataSource) => dataSource.getRepository(UserEntity),
    inject: ['DATA_SOURCE'],
  },
];
```

Дальше эти провайдеры подставляются через `@Inject('USERS_REPOSITORY')` там, где в примерах
ниже стоит `@InjectRepository(UserEntity)`.

---

## Контроллер

Основной способ. Даёт контроль над кодами ошибок, формой ответа и ограничениями доступа.

```ts
import { Controller, Get, Query } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { executeQuery, type QueryParams } from 'odata-v4-typeorm-improved';
import { Repository } from 'typeorm';

import { UserEntity } from '../entities/user.entity';

@Controller('api/users')
export class UsersController {
  constructor(
    @InjectRepository(UserEntity) private readonly repository: Repository<UserEntity>
  ) {}

  @Get()
  find(@Query() query: QueryParams) {
    return executeQuery(this.repository, query, {
      // alias обязан совпадать с именем класса сущности или именем её таблицы
      alias: 'UserEntity',
      maxTop: 100,
      allowedFields: ['id', 'name', 'email', 'posts/id', 'posts/title'],
      allowedExpands: ['posts'],
    });
  }
}
```

Возвращать промис прямо из метода можно: Nest дождётся его сам. Форма ответа зависит
от `$count` — [подробности](./recipes.md#форма-ответа-массив-или-объект-со-счётчиком).

### `$`-параметры и `ValidationPipe`

`QueryParams` — интерфейс, а не класс. Глобальный `ValidationPipe` такой аргумент
пропускает мимо (метатип — `Object`), поэтому параметры доходят до библиотеки как есть.

Опасность появляется, если объявить DTO-**классом**: с `whitelist: true` пайп молча
вырезает всё, на чём нет декораторов валидации, — и `$filter` до `executeQuery` не дойдёт.
Запрос при этом выполнится успешно, вернув **не отфильтрованные** данные.

```ts
// ❌ с whitelist: true — $filter и остальные параметры молча исчезнут
class UsersQueryDto {
  $filter?: string;
}

// ✅ либо @Query() без класса, либо декоратор на каждом поле
class UsersQueryDto {
  @IsOptional()
  @IsString()
  $filter?: string;
}
```

Проще держать `@Query() query: QueryParams`: валидировать здесь нечего — некорректный
OData библиотека и так отвергает клиентской ошибкой.

---

## Ошибки OData → `400`

Ошибки библиотеки — обычные исключения, а не `HttpException`, поэтому по умолчанию Nest
отдаст на них `500`. Интерцептор переводит их в `400`, не трогая остальные:

```ts
// odata-error.interceptor.ts
import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { isODataClientError } from 'odata-v4-typeorm-improved';
import { catchError, throwError } from 'rxjs';
import { QueryFailedError } from 'typeorm';

@Injectable()
export class ODataErrorInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler) {
    return next.handle().pipe(
      catchError((error: unknown) => {
        // Признак isClientError несут все ошибки библиотеки — разбирать текст не нужно
        if (isODataClientError(error)) {
          return throwError(() => new BadRequestException(error.message));
        }

        // Несуществующая колонка в $filter или $orderby: имена по метаданным
        // не проверяются, поэтому такой запрос доходит до СУБД. Текст её ошибки
        // наружу отдавать не нужно — он останется в логе Nest.
        if (error instanceof QueryFailedError) {
          return throwError(() => new BadRequestException('Invalid OData query.'));
        }

        return throwError(() => error);
      })
    );
  }
}
```

```ts
// main.ts — либо глобально, либо @UseInterceptors(ODataErrorInterceptor) на контроллере
app.useGlobalInterceptors(new ODataErrorInterceptor());
```

> Интерцептор, а не `ExceptionFilter`, потому что фильтр обязан ответить сам — а значит,
> привязан к API `res` конкретного адаптера (`res.json()` в Express, `res.send()`
> в Fastify). Здесь же исключение просто подменяется, а ответ формирует Nest.
> Если фильтр всё-таки нужен, объявляйте его как `@Catch(ODataError, QueryFailedError)`,
> чтобы не перехватывать чужие исключения.

---

## Права пользователя и мультиарендность

Ограничения, зависящие от текущего запроса, задаются построителем: OData-условия
добавляются к вашему через `andWhere`, обойти его нельзя.

```ts
import { Controller, Get, Query, Req } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { executeQuery, type QueryParams } from 'odata-v4-typeorm-improved';
import { Repository } from 'typeorm';

@Controller('api/documents')
export class DocumentsController {
  constructor(
    @InjectRepository(DocumentEntity) private readonly repository: Repository<DocumentEntity>
  ) {}

  @Get()
  find(@Query() query: QueryParams, @Req() req: RequestWithUser) {
    const qb = this.repository
      .createQueryBuilder('DocumentEntity')
      .where('DocumentEntity.tenantId = :tenantId', { tenantId: req.user.tenantId });

    return executeQuery(qb, query, { maxTop: 100 });
  }
}
```

`alias` при готовом построителе можно не задавать: метаданные и корневой алиас библиотека
берёт у него самого.

> Именно поэтому `ODataQueryMiddleware` здесь не подходит: репозиторий захватывается
> замыканием один раз при создании middleware и текущего запроса не видит.

---

## Конверт OData через интерцептор

Библиотека отдаёт «сырой» результат. Обёртка в конверт — на стороне приложения; в NestJS
её удобно вынести из контроллеров в интерцептор.

```ts
// odata-envelope.interceptor.ts
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { GetManyResponse } from 'odata-v4-typeorm-improved';
import { map } from 'rxjs';
import type { ObjectLiteral } from 'typeorm';

@Injectable()
export class ODataEnvelopeInterceptor implements NestInterceptor {
  constructor(private readonly entitySet: string) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<{
      protocol: string;
      headers: Record<string, string | undefined>;
    }>();

    const odataContext =
      `${request.protocol}://${request.headers.host}/api/$metadata#${this.entitySet}`;

    return next.handle().pipe(
      map((result: ObjectLiteral[] | GetManyResponse<ObjectLiteral>) => {
        const items = Array.isArray(result) ? result : result.items;
        const count = Array.isArray(result) ? undefined : result.count;

        return {
          '@odata.context': odataContext,
          // @odata.count добавляется только на $count=true — иначе клиент
          // решит, что счётчик равен нулю
          ...(count !== undefined && { '@odata.count': count }),
          value: items,
        };
      })
    );
  }
}
```

```ts
@Controller('api/users')
@UseInterceptors(new ODataEnvelopeInterceptor('Users'))
export class UsersController { /* … */ }
```

За прокси `request.protocol` вернёт `http`, пока адаптеру не сказано доверять заголовкам
`X-Forwarded-*`: в Express это `app.set('trust proxy', true)`, в Fastify — опция
`trustProxy` при создании `FastifyAdapter`. Иначе клиент получит контекст с неверной схемой.

---

## Схема сервиса на `$metadata`

`createMetadataDocument` возвращает строку CSDL XML и HTTP не касается — на любом адаптере
работает одинаково. Документ зависит только от метаданных, поэтому считается один раз.

```ts
// odata-metadata.service.ts
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createMetadataDocument } from 'odata-v4-typeorm-improved';
import { DataSource } from 'typeorm';

@Injectable()
export class ODataMetadataService {
  private document?: string;

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  get(): string {
    // Неудачная попытка не кэшируется: исключение из createMetadataDocument
    // не запишет document, и следующий запрос попробует снова
    return (this.document ??= createMetadataDocument(this.dataSource, {
      namespace: 'Shop',
      entities: [UserEntity, PostEntity],
      entitySetName: (metadata) => metadata.tableName,
    }));
  }
}
```

```ts
// odata-metadata.controller.ts
import { Controller, Get, Header } from '@nestjs/common';

@Controller('api')
export class ODataMetadataController {
  constructor(private readonly metadata: ODataMetadataService) {}

  @Get('$metadata')
  @Header('Content-Type', 'application/xml')
  @Header('OData-Version', '4.0')
  document(): string {
    return this.metadata.get();
  }
}
```

`$` в пути маршрута — обычный символ, экранировать его не нужно. Путь обязан совпадать
с корнем сервиса, от которого клиент считает адреса наборов: если данные лежат
на `/api/users`, схема должна быть на `/api/$metadata` — учитывайте глобальный префикс
(`app.setGlobalPrefix`), если он задан.

---

## Клиент, который строит интерфейс по схеме (react-admin)

Требования к серверу те же, что и в
[Express-версии рецепта](./recipes-express.md#клиент-который-строит-интерфейс-по-схеме-react-admin):
схема в CSDL XML, списки в конверте OData и маршрут на каждый набор, причём имя `EntitySet`
обязано совпадать с сегментом маршрута.

Контроллер на каждую сущность руками писать не нужно — его можно собрать фабрикой:

```ts
// odata-controller.factory.ts
import { Controller, Get, Query, Type, UseInterceptors } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { executeQuery, type QueryParams } from 'odata-v4-typeorm-improved';
import { DataSource, EntityTarget, ObjectLiteral } from 'typeorm';

export function createODataController<T extends ObjectLiteral>(
  route: string,
  entity: EntityTarget<T>
): Type<unknown> {
  @Controller(`api/${route}`)
  @UseInterceptors(new ODataEnvelopeInterceptor(route))
  class ODataResourceController {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    @Get()
    find(@Query() query: QueryParams) {
      return executeQuery(this.dataSource.getRepository(entity), query, {
        alias: this.dataSource.getMetadata(entity).name,
        maxTop: 100,
      });
    }
  }

  return ODataResourceController;
}
```

```ts
// odata.module.ts
const RESOURCES = { users: UserEntity, posts: PostEntity };

const routeByEntity = new Map<unknown, string>(
  Object.entries(RESOURCES).map(([route, entity]) => [entity, route])
);

@Module({
  controllers: [
    ODataMetadataController,
    ...Object.entries(RESOURCES).map(([route, entity]) => createODataController(route, entity)),
  ],
  providers: [ODataMetadataService],
})
export class ODataModule {}
```

`entitySetName` в `ODataMetadataService` должен давать те же имена, что и маршруты:

```ts
const document = createMetadataDocument(this.dataSource, {
  entities: Object.values(RESOURCES),
  // Клиент берёт EntitySet Name и подставляет его в URL: набор `UserEntity`
  // при маршруте `/api/users` увёл бы его в никуда
  entitySetName: (metadata) => routeByEntity.get(metadata.target) ?? metadata.name,
});
```

> **Что придётся дописать самостоятельно.** Библиотека компилирует query options — и только
> их. Адресация по ключу (`/api/users(1)`), служебный документ в корне сервиса, а также
> создание, изменение и удаление записей в неё не входят: это маршрутизация и запись,
> а не трансляция запроса. Провайдеру react-admin они нужны для `getOne`, `create`,
> `update` и `delete`, поэтому их обработчики пишутся руками поверх обычного репозитория
> TypeORM.

---

## Middleware вместо контроллера

Годится там, где ограничения не зависят от запроса и ответ нужен «как есть». Работает
только на `@nestjs/platform-express`.

```ts
// odata-users.middleware.ts
import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { ODataQueryMiddleware } from 'odata-v4-typeorm-improved';
import { Repository } from 'typeorm';

import { UserEntity } from '../entities/user.entity';

@Injectable()
export class OdataUsersMiddleware implements NestMiddleware {
  constructor(
    @Inject('USERS_REPOSITORY') private readonly usersRepository: Repository<UserEntity>
  ) {}

  use(req: Request, res: Response, next: NextFunction) {
    return ODataQueryMiddleware(this.usersRepository, { alias: 'UserEntity' })(req, res, next);
  }
}
```

```ts
// app.module.ts
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';

import { databaseProviders } from './db/database.providers';
import { OdataUsersMiddleware } from './middlewares/odata-users.middleware';
import { userProviders } from './providers/user.providers';

@Module({
  providers: [...databaseProviders, ...userProviders],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(OdataUsersMiddleware).forRoutes('api/v1/odata/users');
  }
}
```

Обработчик создаётся на каждый запрос заново, но репозиторий в нём один и тот же —
ограничения по текущему пользователю так по-прежнему не задать.

Чего стоит ожидать:

| Что | Почему |
|---|---|
| Интерцепторы и фильтры исключений не сработают | Middleware отвечает раньше контроллера и до пайплайна Nest дело не доходит |
| Конверт OData не добавится | По той же причине — оборачивать нечего, ответ уже отправлен |
| Маршрут можно не объявлять в контроллере | Middleware закрывает запрос сам; при `forRoutes` на несуществующем контроллере ответ всё равно уйдёт |
| `next(error)` — только на `500` | На `400` цепочка останавливается: это штатный сценарий, а не сбой |

---

## Fastify

`ODataQueryMiddleware` и `ODataMetadataMiddleware` на `@nestjs/platform-fastify` не работают:
они вызывают `res.status().json()` — методы Express, которых у объекта ответа Fastify нет.

Всё остальное к адаптеру не привязано: `executeQuery`, `createMetadataDocument`, интерцепторы
из рецептов выше работают на Fastify без изменений. Пользуйтесь
[контроллером](#контроллер) — на этой платформе это единственный способ.
