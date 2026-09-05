/**
 * @file Матрица: опции выполнения (`alias`, `maxTop`, белые списки) и обработка ошибок.
 *
 * Проверяется на реальной БД, потому что все три возможности касаются стыка с TypeORM:
 * метаданных построителя, экранирования идентификаторов и итогового SQL.
 */
import {
  Column,
  DataSource,
  DefaultNamingStrategy,
  Entity,
  PrimaryGeneratedColumn,
  type NamingStrategyInterface,
} from 'typeorm';

import {
  executeQuery,
  ODataInvalidQueryError,
  ODataParseError,
  ODataUnsupportedError,
  isODataClientError,
} from '../../lib';
import { Author } from '../entity';
import { dataSource } from '../setup/dataSource';
import { authorIds, rows } from './helpers';

describe('alias', () => {
  /**
   * Раньше метаданные искались через `connection.getMetadata(alias)`, и произвольный алиас
   * приводил к `No metadata for "u" was found` (дефект A-03). Теперь они берутся
   * у самого построителя, и привычный TypeORM-стиль работает.
   */
  it('произвольный короткий алиас у QueryBuilder', async () => {
    const qb = dataSource.getRepository(Author).createQueryBuilder('u');
    const result = await executeQuery(qb, { $filter: "name eq 'Ada'" });

    expect((result as { items: Author[] }).items.map((a) => a.id)).toEqual([1]);
  });

  it('произвольный алиас работает вместе с $expand и путями в фильтре', async () => {
    const qb = dataSource.getRepository(Author).createQueryBuilder('x');
    const result = await executeQuery(qb, {
      $expand: 'books',
      $filter: "books/title eq 'Analytical Engine'",
    });

    expect((result as { items: Author[] }).items.map((a) => a.id)).toEqual([1]);
  });

  it('имя сущности по-прежнему принимается', async () => {
    expect(await authorIds({ $filter: "name eq 'Ada'" })).toEqual([1]);
  });

  /**
   * `options.alias` имеет приоритет над алиасом построителя — и именно поэтому для готового
   * `SelectQueryBuilder` его либо не задают вовсе, либо задают точно таким же.
   *
   * Алиас идёт в SQL как префикс колонок; если он разойдётся с корневым алиасом построителя,
   * СУБД не найдёт таблицу под этим именем. Тест закрепляет это как контракт, а не как дефект:
   * поведение осмысленно для ветки с `Repository`, где построитель создаётся тем же алиасом.
   */
  it('алиас, разошедшийся с алиасом построителя, даёт ошибку СУБД', async () => {
    const qb = dataSource.getRepository(Author).createQueryBuilder('ignored');

    await expect(executeQuery(qb, { $select: 'id' }, { alias: 'chosen' })).rejects.toThrow(
      /no such column: chosen\.id/
    );
  });

  it('совпадающий алиас в options допустим', async () => {
    const qb = dataSource.getRepository(Author).createQueryBuilder('u');
    const result = await executeQuery(qb, { $select: 'id' }, { alias: 'u' });

    expect((result as { items: Author[] }).items).toHaveLength(4);
  });
});

describe('maxTop', () => {
  it('обрезает $top до разрешённого максимума', async () => {
    const result = await rows(
      dataSource.getRepository(Author),
      { $top: '100', $orderby: 'id asc' },
      'Author'
    );

    expect(result).toHaveLength(4);

    const limited = await executeQuery(
      dataSource.getRepository(Author),
      { $top: '100', $orderby: 'id asc' },
      { alias: 'Author', maxTop: 2 }
    );

    expect((limited as { items: Author[] }).items).toHaveLength(2);
  });

  it('не трогает $top в пределах лимита', async () => {
    const result = await executeQuery(
      dataSource.getRepository(Author),
      { $top: '1', $orderby: 'id asc' },
      { alias: 'Author', maxTop: 10 }
    );

    expect((result as { items: Author[] }).items).toHaveLength(1);
  });

  it('не ограничивает запрос без $top', async () => {
    const result = await executeQuery(
      dataSource.getRepository(Author),
      {},
      { alias: 'Author', maxTop: 2 }
    );

    // maxTop — потолок для явно запрошенной страницы, а не лимит по умолчанию
    expect((result as { items: Author[] }).items).toHaveLength(4);
  });
});

describe('валидация пагинации', () => {
  it.each([
    ['$top', { $top: '-5' }],
    ['$skip', { $skip: '-1' }],
  ])('отрицательный %s отвергается', async (_name, query) => {
    await expect(
      executeQuery(dataSource.getRepository(Author), query, { alias: 'Author' })
    ).rejects.toThrow(ODataInvalidQueryError);
  });

  it('$top=0 остаётся корректным запросом пустой страницы', async () => {
    const result = await executeQuery(
      dataSource.getRepository(Author),
      { $top: '0', $count: 'true' },
      { alias: 'Author' }
    );

    expect(result).toEqual({ items: [], count: 4 });
  });
});

describe('белые списки полей и связей', () => {
  it('разрешённые поля проходят', async () => {
    const result = await rows(dataSource.getRepository(Author), { $select: 'id,name' }, 'Author');

    expect(result).toHaveLength(4);
  });

  it('$select с полем вне списка отвергается', async () => {
    await expect(
      executeQuery(
        dataSource.getRepository(Author),
        { $select: 'id,bio' },
        { alias: 'Author', allowedFields: ['id', 'name'] }
      )
    ).rejects.toThrow(ODataInvalidQueryError);
  });

  it('$filter с полем вне списка отвергается', async () => {
    await expect(
      executeQuery(
        dataSource.getRepository(Author),
        { $filter: 'age gt 30' },
        { alias: 'Author', allowedFields: ['id', 'name'] }
      )
    ).rejects.toThrow(ODataInvalidQueryError);
  });

  it('поле внутри функции тоже проверяется', async () => {
    // Разбор $filter регулярными выражениями такой случай бы пропустил —
    // поэтому список полей собирается посетителем во время обхода AST.
    await expect(
      executeQuery(
        dataSource.getRepository(Author),
        { $filter: "contains(bio,'x')" },
        { alias: 'Author', allowedFields: ['id', 'name'] }
      )
    ).rejects.toThrow(ODataInvalidQueryError);
  });

  it('$orderby с полем вне списка отвергается', async () => {
    await expect(
      executeQuery(
        dataSource.getRepository(Author),
        { $orderby: 'age desc' },
        { alias: 'Author', allowedFields: ['id', 'name'] }
      )
    ).rejects.toThrow(ODataInvalidQueryError);
  });

  it('$expand со связью вне списка отвергается', async () => {
    await expect(
      executeQuery(
        dataSource.getRepository(Author),
        { $expand: 'books' },
        { alias: 'Author', allowedExpands: [] }
      )
    ).rejects.toThrow(ODataInvalidQueryError);
  });

  it('связь, затронутая только фильтром, тоже проверяется', async () => {
    await expect(
      executeQuery(
        dataSource.getRepository(Author),
        { $filter: "books/title eq 'x'" },
        { alias: 'Author', allowedExpands: [] }
      )
    ).rejects.toThrow(ODataInvalidQueryError);
  });

  it('вложенная связь проверяется на своём уровне', async () => {
    await expect(
      executeQuery(
        dataSource.getRepository(Author),
        { $expand: 'books($expand=reviews)' },
        { alias: 'Author', allowedExpands: ['books'] }
      )
    ).rejects.toThrow(ODataInvalidQueryError);
  });

  it('разрешённая цепочка связей проходит', async () => {
    const result = await executeQuery(
      dataSource.getRepository(Author),
      { $expand: 'books($expand=reviews)', $filter: "name eq 'Ada'" },
      { alias: 'Author', allowedExpands: ['books', 'reviews'] }
    );

    expect((result as { items: Author[] }).items[0].books).toHaveLength(2);
  });

  it('поле связи задаётся полным путём от корня', async () => {
    const result = await executeQuery(
      dataSource.getRepository(Author),
      { $select: 'id', $expand: 'books($select=title)', $filter: "name eq 'Ada'" },
      {
        alias: 'Author',
        // 'name' нужен фильтру, 'books/title' — вложенному $select.
        // Список покрывает все затронутые поля, а не только те, что в $select.
        allowedFields: ['id', 'name', 'books/title'],
        allowedExpands: ['books'],
      }
    );

    expect((result as { items: Author[] }).items).toHaveLength(1);
  });

  it('вложенное поле связи вне списка отвергается', async () => {
    await expect(
      executeQuery(
        dataSource.getRepository(Author),
        { $expand: 'books($select=pages)' },
        { alias: 'Author', allowedFields: ['id', 'books/title'], allowedExpands: ['books'] }
      )
    ).rejects.toThrow(ODataInvalidQueryError);
  });

  it('без списков ограничений нет', async () => {
    const result = await rows(dataSource.getRepository(Author), { $expand: 'books' }, 'Author');

    expect(result).toHaveLength(4);
  });
});

describe('классификация ошибок', () => {
  it.each([
    ['синтаксис', { $filter: '!!!' }, ODataParseError],
    ['неподдерживаемая функция', { $filter: 'geo.distance(a,b) lt 1' }, ODataUnsupportedError],
    ['лямбда', { $filter: "books/any(b: b/title eq 'x')" }, ODataUnsupportedError],
    ['отрицательный $top', { $top: '-1' }, ODataInvalidQueryError],
  ])('%s → типизированная клиентская ошибка', async (_name, query, expected) => {
    let caught: unknown;

    try {
      await executeQuery(dataSource.getRepository(Author), query, { alias: 'Author' });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(expected);
    expect(isODataClientError(caught)).toBe(true);
  });

  it('ODataParseError сообщает позицию, если парсер её выдал', async () => {
    let caught: ODataParseError | undefined;

    try {
      await executeQuery(dataSource.getRepository(Author), { $filter: '!!!' }, { alias: 'Author' });
    } catch (e) {
      caught = e as ODataParseError;
    }

    expect(caught?.position).toBe(0);
    expect(caught?.source).toContain('!!!');
  });

  it('ошибка СУБД не считается ошибкой библиотеки', async () => {
    // Несуществующая колонка: по метаданным имена не проверяются, ошибка приходит от драйвера.
    let caught: unknown;

    try {
      await executeQuery(
        dataSource.getRepository(Author),
        { $filter: 'nonexistent eq 1' },
        { alias: 'Author' }
      );
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeDefined();
    expect(isODataClientError(caught)).toBe(false);
  });
});

/**
 * Дефект A-05: `$search` подставлял в SQL имя свойства класса вместо имени колонки и
 * цитировал идентификаторы жёстко зашитыми двойными кавычками. При snake_case-стратегии
 * запрос падал с `no such column: Account.firstName`.
 */
describe('$search при нестандартной namingStrategy', () => {
  class SnakeNamingStrategy extends DefaultNamingStrategy implements NamingStrategyInterface {
    columnName(propertyName: string, customName: string): string {
      return customName || propertyName.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
    }
  }

  @Entity()
  class Account {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column()
    firstName!: string;

    @Column('integer')
    yearsOld!: number;
  }

  let snakeDataSource: DataSource;

  beforeAll(async () => {
    snakeDataSource = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      synchronize: true,
      entities: [Account],
      namingStrategy: new SnakeNamingStrategy(),
      logging: false,
    });

    await snakeDataSource.initialize();
  });

  afterAll(async () => {
    await snakeDataSource.destroy();
  });

  beforeEach(async () => {
    await snakeDataSource.synchronize(true);
    await snakeDataSource
      .getRepository(Account)
      .save([
        { firstName: 'Anna', yearsOld: 30 },
        { firstName: 'Boris', yearsOld: 40 },
      ]);
  });

  it('ищет по текстовой колонке', async () => {
    const result = await executeQuery(
      snakeDataSource.getRepository(Account),
      { $search: 'ann' },
      { alias: 'Account' }
    );

    expect((result as { items: Account[] }).items.map((a) => a.firstName)).toEqual(['Anna']);
  });

  it('ищет по числовой колонке', async () => {
    const result = await executeQuery(
      snakeDataSource.getRepository(Account),
      { $search: '40' },
      { alias: 'Account' }
    );

    expect((result as { items: Account[] }).items.map((a) => a.firstName)).toEqual(['Boris']);
  });

  it('$filter по тому же полю тоже работает', async () => {
    const result = await executeQuery(
      snakeDataSource.getRepository(Account),
      { $filter: "firstName eq 'Anna'" },
      { alias: 'Account' }
    );

    expect((result as { items: Account[] }).items).toHaveLength(1);
  });
});

/**
 * Дефект A-12: колонки с `@Column({ select: false })` возвращались клиенту.
 *
 * Такая пометка — способ TypeORM сказать «эта колонка не покидает сервер по умолчанию»;
 * типовое применение — хеши паролей и токены. Собственный `find()` в TypeORM их скрывает,
 * а библиотека возвращала их **на каждом запросе**, даже без единого параметра, потому что
 * строила список SELECT из всех невиртуальных колонок и явно переопределяла умолчание TypeORM.
 */
describe('колонки с select: false', () => {
  @Entity()
  class Credential {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column()
    login!: string;

    @Column({ select: false })
    passwordHash!: string;
  }

  let hiddenDataSource: DataSource;

  beforeAll(async () => {
    hiddenDataSource = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      synchronize: true,
      entities: [Credential],
      logging: false,
    });

    await hiddenDataSource.initialize();
  });

  afterAll(async () => {
    await hiddenDataSource.destroy();
  });

  beforeEach(async () => {
    await hiddenDataSource.synchronize(true);
    await hiddenDataSource
      .getRepository(Credential)
      .save({ login: 'root', passwordHash: 'SECRET-HASH' });
  });

  const query = (params: Record<string, string>) =>
    executeQuery(hiddenDataSource.getRepository(Credential), params, { alias: 'Credential' });

  it('скрытая колонка не попадает в ответ по умолчанию', async () => {
    const result = (await query({})) as { items: Credential[] };

    expect(result.items[0]).toEqual({ id: 1, login: 'root' });
    expect(JSON.stringify(result)).not.toContain('SECRET-HASH');
  });

  it('поведение совпадает с find() самого TypeORM', async () => {
    const viaLibrary = (await query({})) as { items: Credential[] };
    const viaTypeorm = await hiddenDataSource.getRepository(Credential).find();

    expect(viaLibrary.items).toEqual(viaTypeorm);
  });

  it.each([
    ['$select', { $select: 'id,passwordHash' }],
    ['$filter', { $filter: "passwordHash eq 'SECRET-HASH'" }],
    ['$orderby', { $orderby: 'passwordHash asc' }],
  ])('обращение к скрытой колонке через %s отвергается', async (_name, params) => {
    // $filter и $orderby не возвращают значение колонки, но работают как оракул:
    // по числу строк в ответе значение подбирается.
    await expect(query(params)).rejects.toThrow(ODataInvalidQueryError);
  });

  it('обычные колонки по-прежнему доступны', async () => {
    const result = (await query({ $select: 'id,login' })) as { items: Credential[] };

    expect(result.items[0]).toEqual({ id: 1, login: 'root' });
  });
});
