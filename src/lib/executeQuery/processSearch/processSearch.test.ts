/**
 * @file Компиляция `$search` в SQL.
 *
 * Структуру выражения проверяет `parseSearch.test`; здесь — во что она превращается:
 * какие колонки участвуют, как выглядит условие терма и как собираются параметры.
 *
 * Набор колонок задаётся моком метаданных: перебирать типы колонок на живой базе значило бы
 * заводить сущность на каждый случай. Поиск по полям связей проверяется отдельно, на настоящих
 * метаданных — там мок описывал бы представление автора о TypeORM, а не TypeORM.
 */
import type { EntityMetadata, ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import { Brackets } from 'typeorm';

import { ODataInvalidQueryError } from '../../errors';
import { dataSource } from '../../../test/setup/dataSource';
import { processSearch, type ProcessSearchOptions } from './processSearch';

/**
 * Мок QueryBuilder.
 *
 * `connection.driver.escape` обязателен: имена таблицы и колонок экранирует драйвер,
 * а не жёстко зашитые кавычки — иначе `$search` не работал бы на MySQL. Здесь берётся
 * ANSI-форма с двойными кавычками, как в PostgreSQL и SQLite.
 */
const createMockQueryBuilder = (dialect = 'sqlite') => {
  const mock = {
    andWhere: jest.fn().mockReturnThis(),
    connection: {
      driver: { escape: (identifier: string) => `"${identifier}"` },
      // Диалект нужен режиму 'fulltext'; для 'like' достаточно, чтобы поле существовало.
      options: { type: dialect },
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
      propertyPath: col.propertyName,
      databaseName: col.databaseName ?? col.propertyName,
      type: col.type,
      relationMetadata: undefined,
    })),
    relations: [],
  } as unknown as EntityMetadata;
};

/** Условие и параметры, с которыми `processSearch` дёрнул `andWhere`. */
function compiled(queryBuilder: SelectQueryBuilder<ObjectLiteral>): {
  condition: string;
  parameters: Record<string, string | number>;
} {
  const calls = (queryBuilder.andWhere as jest.Mock).mock.calls;

  expect(calls).toHaveLength(1);

  const [brackets, parameters] = calls[0] as [Brackets, Record<string, string | number>];
  let condition = '';

  brackets.whereFactory({
    where: (value: string) => {
      condition = value;

      return undefined as never;
    },
  } as never);

  return { condition, parameters };
}

/** Выполняет поиск на моке и возвращает результат компиляции. */
function run(
  metadata: EntityMetadata,
  search: string,
  options?: ProcessSearchOptions
): { condition: string; parameters: Record<string, string | number> } {
  const queryBuilder = createMockQueryBuilder();

  processSearch(queryBuilder, metadata, search, 'entity', options);

  return compiled(queryBuilder);
}

const textAndNumber = createMockMetadata([
  { propertyName: 'title', type: 'varchar' },
  { propertyName: 'age', type: 'integer' },
]);

describe('processSearch', () => {
  describe('один терм', () => {
    it('текстовая колонка сравнивается по подстроке, числовая пропускается', () => {
      const { condition, parameters } = run(textAndNumber, 'hello');

      // Внешние скобки — от терма: он объединяет совпадения по всем колонкам через OR.
      expect(condition).toBe(
        `(("entity"."title" IS NOT NULL AND LOWER("entity"."title") LIKE :searchText0 ESCAPE '!'))`
      );
      expect(parameters).toEqual({ searchText0: '%hello%' });
    });

    it('числовое значение ищется и по числовым колонкам — на точное равенство', () => {
      const { condition, parameters } = run(textAndNumber, '42');

      expect(condition).toContain(`LOWER("entity"."title") LIKE :searchText0`);
      expect(condition).toContain(
        `("entity"."age" IS NOT NULL AND "entity"."age" = :searchNumber0)`
      );
      expect(parameters).toEqual({ searchText0: '%42%', searchNumber0: 42 });
    });

    it('нечисловое значение по числовым колонкам не ищется', () => {
      const { condition, parameters } = run(textAndNumber, '123abc');

      expect(condition).not.toContain('searchNumber');
      expect(parameters).toEqual({ searchText0: '%123abc%' });
    });

    /**
     * Проверка на NULL не украшение: без неё `LIKE` по пустой колонке даёт `NULL`,
     * и `NOT` над таким условием выбросил бы строки, которые обязан оставить.
     */
    it('каждое сравнение защищено проверкой на NULL', () => {
      const { condition } = run(textAndNumber, 'x');

      expect(condition).toContain('"entity"."title" IS NOT NULL AND');
    });

    it('спецсимволы шаблона экранируются', () => {
      const { parameters } = run(textAndNumber, '50%_!');

      expect(parameters.searchText0).toBe('%50!%!_!!%');
    });

    it('имя колонки берётся из databaseName, а не из имени свойства', () => {
      // Дефект A-05: при snake_case в SQL уходило имя свойства, и запрос падал.
      const metadata = createMockMetadata([
        { propertyName: 'firstName', databaseName: 'first_name', type: 'varchar' },
      ]);

      expect(run(metadata, 'ann').condition).toContain('"entity"."first_name"');
    });
  });

  describe('операторы', () => {
    it('соседние слова соединяются через AND, у каждого свой параметр', () => {
      const { condition, parameters } = run(textAndNumber, 'ada lovelace');

      expect(condition).toContain(' AND ');
      expect(parameters).toEqual({ searchText0: '%ada%', searchText1: '%lovelace%' });
    });

    it('OR', () => {
      const { condition } = run(textAndNumber, 'ada OR grace');

      expect(condition).toContain(' OR ');
      expect(condition).toContain(':searchText0');
      expect(condition).toContain(':searchText1');
    });

    it('NOT', () => {
      const { condition } = run(textAndNumber, 'NOT ada');

      expect(condition.startsWith('NOT ')).toBe(true);
    });

    it('фраза ищется целиком, вместе с пробелами', () => {
      const { parameters } = run(textAndNumber, '"ada lovelace"');

      expect(parameters).toEqual({ searchText0: '%ada lovelace%' });
    });

    it('скобки сохраняют приоритет', () => {
      const { condition } = run(textAndNumber, '(ada OR grace) hopper');

      // Внешнее соединение — AND, внутри левой части — OR.
      expect(condition).toMatch(/^\(\([\s\S]* OR [\s\S]*\) AND [\s\S]*\)$/);
    });
  });

  describe('когда искать нечего', () => {
    it('пустая строка не добавляет условий', () => {
      const queryBuilder = createMockQueryBuilder();

      processSearch(queryBuilder, textAndNumber, '', 'entity');
      processSearch(queryBuilder, textAndNumber, '   ', 'entity');

      expect(queryBuilder.andWhere).not.toHaveBeenCalled();
    });

    it('null и undefined не добавляют условий', () => {
      const queryBuilder = createMockQueryBuilder();

      processSearch(queryBuilder, textAndNumber, null as unknown as string, 'entity');
      processSearch(queryBuilder, textAndNumber, undefined as unknown as string, 'entity');

      expect(queryBuilder.andWhere).not.toHaveBeenCalled();
    });

    it('у сущности нет пригодных колонок — поиск игнорируется', () => {
      const queryBuilder = createMockQueryBuilder();
      const metadata = createMockMetadata([{ propertyName: 'createdAt', type: 'timestamp' }]);

      processSearch(queryBuilder, metadata, 'ada', 'entity');

      expect(queryBuilder.andWhere).not.toHaveBeenCalled();
    });

    it('слово несравнимо ни с одной колонкой — терм не совпадает ни с чем', () => {
      const metadata = createMockMetadata([{ propertyName: 'age', type: 'integer' }]);

      expect(run(metadata, 'abc').condition).toBe('1 = 0');
    });
  });

  describe('searchFields', () => {
    it('ограничивает набор колонок корня', () => {
      const metadata = createMockMetadata([
        { propertyName: 'title', type: 'varchar' },
        { propertyName: 'secret', type: 'varchar' },
      ]);

      const { condition } = run(metadata, 'ada', { fields: ['title'] });

      expect(condition).toContain('"entity"."title"');
      expect(condition).not.toContain('secret');
    });

    it('поле связи компилируется в EXISTS, а не в JOIN', () => {
      // На настоящих метаданных: условие связи целиком строится из них.
      const queryBuilder = createMockQueryBuilder();

      processSearch(queryBuilder, dataSource.getMetadata('Book'), 'ada', 'Book', {
        fields: ['author/name'],
      });

      const { condition } = compiled(queryBuilder);

      expect(condition).toContain('EXISTS (SELECT 1 FROM "author" "Book__s0"');
      expect(condition).toContain('"Book__s0"."id" = "Book"."author_id"');
      expect(condition).toContain('LOWER("Book__s0"."name") LIKE :searchText0');
    });

    it('поле связи «один ко многим» тоже даёт EXISTS — число строк не меняется', () => {
      const queryBuilder = createMockQueryBuilder();

      processSearch(queryBuilder, dataSource.getMetadata('Author'), 'engine', 'Author', {
        fields: ['books/title'],
      });

      const { condition } = compiled(queryBuilder);

      expect(condition).toContain('EXISTS (SELECT 1 FROM "book" "Author__s0"');
      expect(condition).toContain('"Author__s0"."author_id" = "Author"."id"');
    });

    it('поле связи «многие ко многим» проходит через таблицу связей', () => {
      const queryBuilder = createMockQueryBuilder();

      processSearch(queryBuilder, dataSource.getMetadata('Book'), 'classic', 'Book', {
        fields: ['tags/label'],
      });

      const { condition } = compiled(queryBuilder);

      expect(condition).toContain('"book_tag" "Book__s0__jt"');
      expect(condition).toContain('"Book__s0__jt"."book_id" = "Book"."id"');
      expect(condition).toContain('"Book__s0__jt"."tag_id" = "Book__s0"."id"');
    });

    /**
     * Путь через две связи даёт один `EXISTS` с двумя таблицами, а не два вложенных:
     * соединение остаётся соединением независимо от того, записано оно вложенностью
     * или списком, а читается линейный вариант проще.
     */
    it('путь через две связи даёт один EXISTS с двумя таблицами', () => {
      const queryBuilder = createMockQueryBuilder();

      processSearch(queryBuilder, dataSource.getMetadata('Author'), 'brilliant', 'Author', {
        fields: ['books/reviews/text'],
      });

      const { condition } = compiled(queryBuilder);

      expect(condition.match(/EXISTS/g)).toHaveLength(1);
      expect(condition).toContain('"book" "Author__s0__n0", "review" "Author__s0"');
      expect(condition).toContain('"Author__s0"."book_id" = "Author__s0__n0"."id"');
    });

    it.each([
      ['несуществующее поле', ['nope']],
      ['несуществующая связь', ['nope/name']],
      ['поле, по которому искать нельзя', ['registeredAt']],
    ])('%s отвергается ошибкой', (_name, fields) => {
      expect(() =>
        processSearch(createMockQueryBuilder(), dataSource.getMetadata('Author'), 'x', 'Author', {
          fields,
        })
      ).toThrow(ODataInvalidQueryError);
    });
  });

  describe('режим fulltext', () => {
    /** Тот же прогон, но на моке заданного диалекта. */
    function runOn(dialect: string, search: string, options?: ProcessSearchOptions) {
      const queryBuilder = createMockQueryBuilder(dialect);

      processSearch(queryBuilder, textAndNumber, search, 'entity', {
        mode: 'fulltext',
        ...options,
      });

      return compiled(queryBuilder);
    }

    it('PostgreSQL: слово ищется через plainto_tsquery', () => {
      const { condition, parameters } = runOn('postgres', 'ada');

      expect(condition).toContain(`to_tsvector('simple', "entity"."title") @@`);
      expect(condition).toContain(`plainto_tsquery('simple', :searchText0)`);
      // Значение уходит как есть: шаблон LIKE здесь не при чём.
      expect(parameters).toEqual({ searchText0: 'ada' });
    });

    it('PostgreSQL: у фразы важен порядок слов — phraseto_tsquery', () => {
      expect(runOn('postgres', '"ada lovelace"').condition).toContain('phraseto_tsquery');
    });

    it('PostgreSQL: язык влияет и на разбор колонки, и на разбор запроса', () => {
      const { condition } = runOn('postgres', 'ada', { language: 'russian' });

      expect(condition).toContain(`to_tsvector('russian', "entity"."title")`);
      expect(condition).toContain(`plainto_tsquery('russian', :searchText0)`);
    });

    it('язык проверяется: имя подставляется в SQL, а не передаётся параметром', () => {
      expect(() =>
        runOn('postgres', 'ada', { language: "simple'); DROP TABLE author; --" })
      ).toThrow(ODataInvalidQueryError);
    });

    it('MySQL: MATCH … AGAINST в булевом режиме', () => {
      const { condition, parameters } = runOn('mysql', 'ada');

      expect(condition).toContain('MATCH("entity"."title") AGAINST(:searchText0 IN BOOLEAN MODE)');
      // Кавычки обезвреживают операторы булева режима: `-ada` не должно означать исключение.
      expect(parameters).toEqual({ searchText0: '"ada"' });
    });

    it('MySQL: операторы булева режима не проходят внутрь', () => {
      expect(runOn('mysql', '-ada').parameters).toEqual({ searchText0: '"-ada"' });
    });

    /**
     * Один и тот же код обычно работает на SQLite в разработке и на PostgreSQL в продакшене.
     * Падать на этом различии он не должен, поэтому режим молча остаётся 'like'.
     */
    it('SQLite и MS SQL остаются на LIKE', () => {
      expect(runOn('sqlite', 'ada').condition).toContain('LIKE :searchText0');
      expect(runOn('mssql', 'ada').condition).toContain('LIKE :searchText0');
    });

    it('числовые колонки сравниваются на равенство в любом режиме', () => {
      expect(runOn('postgres', '42').condition).toContain('"entity"."age" = :searchNumber0');
    });
  });

  describe('ошибки выражения', () => {
    it('незакрытая кавычка отвергается', () => {
      expect(() => run(textAndNumber, '"ada')).toThrow(ODataInvalidQueryError);
    });
  });
});
