import type { EntityMetadata, ObjectLiteral, SelectQueryBuilder } from 'typeorm';

import { TypeOrmVisitor } from '../../TypeOrmVisitor';
import { processIncludes } from './processIncludes';

describe('processIncludes', () => {
  let mockQueryBuilder: jest.Mocked<SelectQueryBuilder<ObjectLiteral>>;
  let parentMetadata: EntityMetadata;
  const alias = 'parent';

  beforeEach(() => {
    // Создаём мок QueryBuilder
    mockQueryBuilder = {
      leftJoin: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      connection: {
        getMetadata: jest.fn().mockReturnValue({ relations: [] }),
      },
    } as unknown as jest.Mocked<SelectQueryBuilder<ObjectLiteral>>;

    parentMetadata = {
      relations: [
        { propertyPath: 'items', type: () => {} } as unknown as EntityMetadata['relations'][0],
      ],
    } as unknown as EntityMetadata;
  });

  it('не должен ничего делать, если odataQuery.includes пуст', () => {
    const odataQuery = { includes: [] } as Partial<TypeOrmVisitor>;
    const result = processIncludes(mockQueryBuilder, odataQuery, alias, parentMetadata);
    expect(result).toBe(mockQueryBuilder);
    expect(mockQueryBuilder.leftJoin).not.toHaveBeenCalled();
  });

  it('должен добавить leftJoinAndSelect, если item.select === "*"', () => {
    const odataQuery = {
      includes: [
        {
          navigationProperty: 'items',
          alias: 'itemsAlias',
          select: '*',
          where: 'itemsAlias.id = parent.id',
          parameters: new Map([['param1', 'value1']]),
        },
      ],
    } as Partial<TypeOrmVisitor>;
    processIncludes(mockQueryBuilder, odataQuery, alias, parentMetadata);
    expect(mockQueryBuilder.leftJoinAndSelect).toHaveBeenCalledWith(
      `${alias}.items`,
      'itemsAlias',
      'itemsAlias.id = parent.id',
      { param1: 'value1' }
    );
    expect(mockQueryBuilder.addSelect).not.toHaveBeenCalled();
  });

  it('должен добавить leftJoin и addSelect, если item.select не "*"', () => {
    const odataQuery = {
      includes: [
        {
          navigationProperty: 'items',
          alias: 'itemsAlias',
          select: 'id, name',
          where: 'itemsAlias.id = parent.id',
          parameters: new Map(),
        },
      ],
    } as Partial<TypeOrmVisitor>;
    processIncludes(mockQueryBuilder, odataQuery, alias, parentMetadata);
    expect(mockQueryBuilder.leftJoin).toHaveBeenCalled();
    expect(mockQueryBuilder.addSelect).toHaveBeenCalledWith(['id', 'name']);
  });

  it('должен обработать сортировку (orderby)', () => {
    const odataQuery = {
      includes: [
        {
          navigationProperty: 'items',
          alias: 'itemsAlias',
          select: '*',
          where: 'itemsAlias.id = parent.id',
          orderby: 'name asc, created desc',
        },
      ],
    } as Partial<TypeOrmVisitor>;
    processIncludes(mockQueryBuilder, odataQuery, alias, parentMetadata);
    expect(mockQueryBuilder.addOrderBy).toHaveBeenCalledTimes(2);
    expect(mockQueryBuilder.addOrderBy).toHaveBeenCalledWith('name', 'asc');
    expect(mockQueryBuilder.addOrderBy).toHaveBeenCalledWith('created', 'desc');
  });

  it('должен игнорировать orderby, если он равен "1"', () => {
    const odataQuery = {
      includes: [
        {
          navigationProperty: 'items',
          alias: 'itemsAlias',
          select: '*',
          where: 'itemsAlias.id = parent.id',
          orderby: '1',
        },
      ],
    } as Partial<TypeOrmVisitor>;
    processIncludes(mockQueryBuilder, odataQuery, alias, parentMetadata);
    expect(mockQueryBuilder.addOrderBy).not.toHaveBeenCalled();
  });

  it('должен рекурсивно обработать вложенные includes', () => {
    const nestedMetadata = { relations: [] };
    (mockQueryBuilder.connection.getMetadata as ReturnType<typeof jest.fn>).mockReturnValue(
      nestedMetadata
    );

    const odataQuery = {
      includes: [
        {
          navigationProperty: 'items',
          alias: 'itemsAlias',
          select: '*',
          where: 'itemsAlias.id = parent.id',
          includes: [
            {
              navigationProperty: 'subItems',
              alias: 'subAlias',
              select: 'id',
              where: 'subAlias.parentId = itemsAlias.id',
            },
          ],
        },
      ],
    } as Partial<TypeOrmVisitor>;
    processIncludes(mockQueryBuilder, odataQuery, alias, parentMetadata);
    // Проверяем, что метод getMetadata был вызван для получения метаданных связи
    expect(mockQueryBuilder.connection.getMetadata).toHaveBeenCalled();
    // Проверяем, что для вложенного include был вызван leftJoin
    expect(mockQueryBuilder.leftJoin).toHaveBeenCalledTimes(1); // для вложенного
    // Дополнительно можно проверить аргументы вызова leftJoin для вложенного
    // Но так как мы не сохраняем промежуточные вызовы, упростим.
  });
});
