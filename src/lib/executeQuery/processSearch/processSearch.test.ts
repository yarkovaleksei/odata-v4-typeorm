import type {
  EntityMetadata,
  ObjectLiteral,
  SelectQueryBuilder,
  WhereExpressionBuilder,
} from 'typeorm';
import { Brackets } from 'typeorm';
import { processSearch } from './processSearch';

type WhereResult = [Brackets, Record<string, string>];

/**
 * Мок QueryBuilder.
 *
 * `connection.driver.escape` обязателен: имена таблицы и колонок экранирует драйвер,
 * а не жёстко зашитые кавычки — иначе `$search` не работал бы на MySQL. Здесь берётся
 * ANSI-форма с двойными кавычками, как в PostgreSQL и SQLite.
 */
const createMockQueryBuilder = () => {
  const mock = {
    andWhere: jest.fn().mockReturnThis(),
    orWhere: jest.fn().mockReturnThis(),
    connection: {
      driver: { escape: (identifier: string) => `"${identifier}"` },
    },
  };

  return mock as unknown as SelectQueryBuilder<ObjectLiteral>;
};

/**
 * Мок EntityMetadata.
 *
 * `databaseName` по умолчанию совпадает с `propertyName` — так ведёт себя стратегия
 * именования TypeORM по умолчанию. Тесты, проверяющие поведение при snake_case,
 * задают его явно.
 */
const createMockMetadata = (
  columns: (Partial<EntityMetadata['columns'][0]> & { databaseName?: string })[]
): EntityMetadata => {
  return {
    columns: columns.map((col) => ({
      propertyName: col.propertyName,
      databaseName: col.databaseName ?? col.propertyName,
      type: col.type,
      relationMetadata: undefined,
    })),
  } as EntityMetadata;
};

describe('processSearch', () => {
  let queryBuilder: SelectQueryBuilder<ObjectLiteral>;
  const alias = 'entity';

  beforeEach(() => {
    queryBuilder = createMockQueryBuilder();
    jest.clearAllMocks();
  });

  test('должен добавить текстовый поиск, если $search – строка', () => {
    const metadata = createMockMetadata([
      { propertyName: 'title', type: 'varchar' },
      { propertyName: 'age', type: 'integer' },
    ]);
    const $search = 'hello';

    processSearch(queryBuilder, metadata, $search, alias);

    expect(queryBuilder.andWhere).toHaveBeenCalledTimes(1);

    const [brackets, params]: WhereResult = (queryBuilder.andWhere as jest.Mock).mock.calls[0];

    expect(brackets).toBeInstanceOf(Brackets);
    expect(params).toEqual({ textSearchValue: '%hello%' });

    // Проверяем внутренние условия
    const innerQb = {
      where: jest.fn().mockReturnThis(),
      orWhere: jest.fn().mockReturnThis(),
    } as Partial<WhereExpressionBuilder>;

    brackets.whereFactory(innerQb as WhereExpressionBuilder);

    expect(innerQb.where).toHaveBeenCalledWith(
      'LOWER("entity"."title") LIKE LOWER(:textSearchValue)'
    );
    expect(innerQb.orWhere).not.toHaveBeenCalled(); // только одна текстовая колонка
  });

  test('должен добавить числовой поиск, если $search – число', () => {
    const metadata = createMockMetadata([
      { propertyName: 'title', type: 'varchar' },
      { propertyName: 'age', type: 'integer' },
    ]);
    const $search = '42';

    processSearch(queryBuilder, metadata, $search, alias);

    const [brackets, params]: WhereResult = (queryBuilder.andWhere as jest.Mock).mock.calls[0];

    expect(params).toEqual({ textSearchValue: '%42%', numberSearchValue: 42 });

    const innerQb = {
      where: jest.fn().mockReturnThis(),
      orWhere: jest.fn().mockReturnThis(),
    } as Partial<WhereExpressionBuilder>;

    brackets.whereFactory(innerQb as WhereExpressionBuilder);

    // Текстовое условие (первое) -> where, числовое -> orWhere
    expect(innerQb.where).toHaveBeenCalledWith(
      'LOWER("entity"."title") LIKE LOWER(:textSearchValue)'
    );
    expect(innerQb.orWhere).toHaveBeenCalledWith('"entity"."age" = :numberSearchValue');
  });

  test('должен добавить только текстовый поиск, если $search – не число', () => {
    const metadata = createMockMetadata([
      { propertyName: 'age', type: 'integer' },
      { propertyName: 'score', type: 'float' },
      { propertyName: 'text', type: 'varchar' },
    ]);
    const $search = 'abc';

    processSearch(queryBuilder, metadata, $search, alias);

    const [brackets, params]: WhereResult = (queryBuilder.andWhere as jest.Mock).mock.calls[0];

    expect(params).toEqual({ textSearchValue: '%abc%' });
    expect(params).not.toHaveProperty('numberSearchValue');

    const innerQb = {
      where: jest.fn().mockReturnThis(),
      orWhere: jest.fn().mockReturnThis(),
    } as Partial<WhereExpressionBuilder>;

    brackets.whereFactory(innerQb as WhereExpressionBuilder);

    expect(innerQb.where).toHaveBeenCalledWith(
      'LOWER("entity"."text") LIKE LOWER(:textSearchValue)'
    );
  });

  test('не должен добавлять числовой поиск, если текстовые колонки есть, но $search – не число', () => {
    const metadata = createMockMetadata([
      { propertyName: 'name', type: 'varchar' },
      { propertyName: 'age', type: 'integer' },
    ]);
    const $search = 'abc123';

    processSearch(queryBuilder, metadata, $search, alias);

    const [, params]: WhereResult = (queryBuilder.andWhere as jest.Mock).mock.calls[0];

    expect(params).toEqual({ textSearchValue: '%abc123%' });
    expect(params).not.toHaveProperty('numberSearchValue');
  });

  test('должен добавить только числовой поиск, если текстовых колонок нет, а $search – число', () => {
    const metadata = createMockMetadata([
      { propertyName: 'age', type: 'integer' },
      { propertyName: 'salary', type: 'decimal' },
    ]);
    const $search = '50000';

    processSearch(queryBuilder, metadata, $search, alias);

    const [brackets, params]: WhereResult = (queryBuilder.andWhere as jest.Mock).mock.calls[0];

    expect(params).toEqual({ numberSearchValue: 50000 });
    expect(params).not.toHaveProperty('textSearchValue');

    const innerQb = {
      where: jest.fn().mockReturnThis(),
      orWhere: jest.fn().mockReturnThis(),
    } as Partial<WhereExpressionBuilder>;

    brackets.whereFactory(innerQb as WhereExpressionBuilder);

    expect(innerQb.where).toHaveBeenCalledWith('"entity"."age" = :numberSearchValue');
    expect(innerQb.orWhere).toHaveBeenCalledWith('"entity"."salary" = :numberSearchValue');
  });

  test('не должен добавлять никаких условий, если $search пустая строка', () => {
    const metadata = createMockMetadata([{ propertyName: 'title', type: 'varchar' }]);

    processSearch(queryBuilder, metadata, '', alias);
    expect(queryBuilder.andWhere).not.toHaveBeenCalled();
  });

  test('не должен добавлять условий, если $search null или undefined', () => {
    const metadata = createMockMetadata([{ propertyName: 'title', type: 'varchar' }]);

    // @ts-ignore
    processSearch(queryBuilder, metadata, null as string, alias);

    expect(queryBuilder.andWhere).not.toHaveBeenCalled();

    // @ts-ignore
    processSearch(queryBuilder, metadata, undefined as string, alias);

    expect(queryBuilder.andWhere).not.toHaveBeenCalled();
  });

  test('должен правильно обрабатывать $search с пробелами', () => {
    const metadata = createMockMetadata([{ propertyName: 'title', type: 'varchar' }]);
    const $search = '  hello world  ';

    processSearch(queryBuilder, metadata, $search, alias);

    const [, params]: WhereResult = (queryBuilder.andWhere as jest.Mock).mock.calls[0];

    expect(params.textSearchValue).toBe('%hello world%');
  });

  test('должен обрабатывать $search, начинающийся с числа, как строку, если есть текстовые колонки', () => {
    const metadata = createMockMetadata([
      { propertyName: 'code', type: 'varchar' },
      { propertyName: 'age', type: 'integer' },
    ]);
    const $search = '123abc';

    processSearch(queryBuilder, metadata, $search, alias);

    const [, params]: WhereResult = (queryBuilder.andWhere as jest.Mock).mock.calls[0];

    expect(params).toEqual({ textSearchValue: '%123abc%' });
    expect(params).not.toHaveProperty('numberSearchValue');
  });
});
