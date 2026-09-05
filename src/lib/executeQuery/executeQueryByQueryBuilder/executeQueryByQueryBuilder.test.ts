import type { EntityMetadata, ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import { Brackets } from 'typeorm';

import { executeQueryByQueryBuilder } from './executeQueryByQueryBuilder';

type WhereResult = [Brackets, Record<string, string>];

describe('executeQueryByQueryBuilder', () => {
  let mockQueryBuilder: jest.Mocked<SelectQueryBuilder<ObjectLiteral>>;
  let mockMetadata: EntityMetadata;

  beforeEach(() => {
    // Мок SelectQueryBuilder
    mockQueryBuilder = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orWhere: jest.fn().mockReturnThis(),
      setParameters: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      expressionMap: { mainAlias: { name: 'defaultAlias' } },
      connection: {
        getMetadata: jest.fn().mockReturnValue({}),
        // options.type читается для выбора диалекта SQL-функций (LENGTH против LEN и т.п.).
        options: { type: 'sqlite' },
        // driver.escape экранирует идентификаторы в условиях $search.
        driver: { escape: (identifier: string) => `"${identifier}"` },
      },
    } as unknown as jest.Mocked<SelectQueryBuilder<ObjectLiteral>>;

    // Мок метаданных.
    // isSelect: true обязателен — колонки с `@Column({ select: false })` исключаются
    // из выборки по умолчанию, и без этого поля мок дал бы пустой SELECT.
    // relations нужен для разрешения путей `связь/поле` при проверке скрытых колонок.
    mockMetadata = {
      nonVirtualColumns: [
        { propertyPath: 'id', isSelect: true },
        { propertyPath: 'name', isSelect: true },
      ],
      columns: [
        { propertyPath: 'id', propertyName: 'id', databaseName: 'id', isSelect: true },
        { propertyPath: 'name', propertyName: 'name', databaseName: 'name', isSelect: true },
        {
          propertyPath: 'content',
          propertyName: 'content',
          databaseName: 'content',
          type: 'varchar',
          isSelect: true,
        },
      ],
      relations: [],
    } as unknown as EntityMetadata;
    (mockQueryBuilder.connection.getMetadata as ReturnType<typeof jest.fn>).mockReturnValue(
      mockMetadata
    );

    jest.clearAllMocks();
  });

  it('должен выполнить запрос без параметров, используя алиас из mainAlias', async () => {
    await executeQueryByQueryBuilder(mockQueryBuilder, {
      $search: undefined,
      $top: '0',
      $skip: '0',
    });

    expect(mockQueryBuilder.select).toHaveBeenCalledWith(['defaultAlias.id', 'defaultAlias.name']);
    expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith('1 = 1');
    expect(mockQueryBuilder.setParameters).toHaveBeenCalledWith({});
    // skip(0) не вызывается: нулевое смещение и его отсутствие — одно и то же,
    // а на MySQL `OFFSET 0` без `LIMIT` вообще не выполняется.
    expect(mockQueryBuilder.skip).not.toHaveBeenCalled();
    // $top='0' — это явно запрошенная пустая страница (OData v4, раздел 11.2.6.4),
    // поэтому take(0) вызывается. «Лимита нет» выражается отсутствием $top, а не нулём.
    expect(mockQueryBuilder.take).toHaveBeenCalledWith(0);
    // $count не передан → по OData v4 (раздел 11.2.5.5) он равен false,
    // поэтому лишний COUNT(*) не выполняется.
    expect(mockQueryBuilder.getMany).toHaveBeenCalled();
    expect(mockQueryBuilder.getManyAndCount).not.toHaveBeenCalled();
  });

  it('не вызывает take, если $top не передан', async () => {
    await executeQueryByQueryBuilder(mockQueryBuilder, { $search: undefined, $skip: '0' });

    expect(mockQueryBuilder.take).not.toHaveBeenCalled();
  });

  it('должен использовать явный select из odataQuery, если он указан', async () => {
    await executeQueryByQueryBuilder(mockQueryBuilder, {
      $search: undefined,
      $top: '0',
      $skip: '0',
      $count: 'false',
    });

    expect(mockQueryBuilder.select).toHaveBeenCalledWith(['defaultAlias.id', 'defaultAlias.name']);
  });

  it('должен применить where и параметры из odataQuery', async () => {
    await executeQueryByQueryBuilder(mockQueryBuilder, {
      $search: undefined,
      $filter: "name eq '@name'",
      $top: '0',
      $skip: '0',
      $count: 'false',
    });

    expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith('defaultAlias.name = :p0');
    expect(mockQueryBuilder.setParameters).toHaveBeenCalledWith({ p0: '@name' });
  });

  it('должен обработать сортировку ($orderby) из odataQuery', async () => {
    await executeQueryByQueryBuilder(mockQueryBuilder, {
      $search: undefined,
      $orderby: 'name asc,created desc',
      $top: '0',
      $skip: '0',
      $count: 'false',
    });

    expect(mockQueryBuilder.addOrderBy).toHaveBeenCalledTimes(2);
    expect(mockQueryBuilder.addOrderBy).toHaveBeenCalledWith('defaultAlias.name', 'ASC');
    expect(mockQueryBuilder.addOrderBy).toHaveBeenCalledWith('defaultAlias.created', 'DESC');
  });

  /**
   * `'1'` — значение `orderby` по умолчанию у базового посетителя (`ORDER BY 1` в чистом SQL).
   * Конвейер трактует его как «сортировка не задана» и не должен добавлять ничего в запрос.
   *
   * Прежняя версия этого теста передавала `$orderby: '1'` как параметр запроса и проверяла
   * вызов `addOrderBy('ASC', undefined)` — то есть закрепляла заведомо бессмысленный результат
   * и при этом не проверяла собственно умолчание. Здесь проверяется именно оно.
   */
  it('не добавляет сортировку, если $orderby не передан', async () => {
    await executeQueryByQueryBuilder(mockQueryBuilder, {
      $search: undefined,
      $top: '0',
      $skip: '0',
      $count: 'false',
    });

    expect(mockQueryBuilder.addOrderBy).not.toHaveBeenCalled();
  });

  it('должен обработать поиск ($search) через processSearch', async () => {
    await executeQueryByQueryBuilder(mockQueryBuilder, {
      $search: 'test',
      $top: '0',
      $skip: '0',
      $count: 'false',
    });

    expect(mockQueryBuilder.andWhere).toHaveBeenCalledTimes(2);
    expect((mockQueryBuilder.andWhere as jest.Mock).mock.calls[0]).toEqual(['1 = 1']);

    const [, params]: WhereResult = (mockQueryBuilder.andWhere as jest.Mock).mock.calls[1];

    expect(params).toEqual({ textSearchValue: '%test%' });
  });

  it('должен применить пагинацию $skip и $top', async () => {
    await executeQueryByQueryBuilder(mockQueryBuilder, {
      $search: undefined,
      $top: '20',
      $skip: '10',
      $count: 'false',
    });

    expect(mockQueryBuilder.skip).toHaveBeenCalledWith(10);
    expect(mockQueryBuilder.take).toHaveBeenCalledWith(20);
  });

  it('должен вернуть { items, count } при $count=true', async () => {
    mockQueryBuilder.getManyAndCount.mockResolvedValue([[{ id: 1 }], 5]);

    const result = await executeQueryByQueryBuilder(mockQueryBuilder, {
      $search: undefined,
      $top: '0',
      $skip: '0',
      $count: 'true',
    });

    expect(mockQueryBuilder.getManyAndCount).toHaveBeenCalled();
    expect(mockQueryBuilder.getMany).not.toHaveBeenCalled();
    expect(result).toEqual({ items: [{ id: 1 }], count: 5 });
  });

  it('должен вернуть массив при $count=false', async () => {
    mockQueryBuilder.getMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);

    const result = await executeQueryByQueryBuilder(mockQueryBuilder, {
      $search: undefined,
      $top: '0',
      $skip: '0',
      $count: 'false',
    });

    expect(mockQueryBuilder.getMany).toHaveBeenCalled();
    expect(mockQueryBuilder.getManyAndCount).not.toHaveBeenCalled();
    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('должен правильно обработать ситуацию, когда в odataQuery нет select, но есть другие поля', async () => {
    await executeQueryByQueryBuilder(mockQueryBuilder, {
      $search: undefined,
      $filter: 'id gt 5',
      $top: '0',
      $skip: '0',
      $count: 'false',
    });

    expect(mockQueryBuilder.select).toHaveBeenCalledWith(['defaultAlias.id', 'defaultAlias.name']);
    expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith('defaultAlias.id > :p0');
  });

  it('должен использовать алиас из mainAlias, если alias не передан в options', async () => {
    // Убедимся, что mainAlias существует
    mockQueryBuilder.expressionMap.mainAlias = {
      name: 'main',
    } as SelectQueryBuilder<ObjectLiteral>['expressionMap']['mainAlias'];

    await executeQueryByQueryBuilder(mockQueryBuilder, {
      $search: undefined,
      $top: '0',
      $skip: '0',
      $count: 'false',
    });

    expect(mockQueryBuilder.select).toHaveBeenCalledWith(['main.id', 'main.name']);
  });

  it('должен использовать алиас из options, а не из mainAlias', async () => {
    // Убедимся, что mainAlias существует
    mockQueryBuilder.expressionMap.mainAlias = {
      name: 'mainAlias',
    } as SelectQueryBuilder<ObjectLiteral>['expressionMap']['mainAlias'];

    await executeQueryByQueryBuilder(
      mockQueryBuilder,
      {
        $search: undefined,
        $top: '0',
        $skip: '0',
        $count: 'false',
      },
      { alias: 'optionsAlias' }
    );

    expect(mockQueryBuilder.select).toHaveBeenCalledWith(['optionsAlias.id', 'optionsAlias.name']);
  });
});
