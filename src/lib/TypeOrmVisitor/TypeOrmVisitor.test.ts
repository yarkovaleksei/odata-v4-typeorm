import { ODataInvalidQueryError, ODataUnsupportedError } from '../errors';
import { parseQueryOptions, type Token, TokenType } from '../odataParser';
import type { ColumnTypeResolver, RelationResolver, RelationSource, SqlOptions } from '../types';
import { TypeOrmVisitor } from './TypeOrmVisitor';

/**
 * Разрешение связей без метаданных: подзапрос собирается из имени связи по одному правилу.
 *
 * Настоящий резолвер (`createRelationResolver`) проверяется своими тестами на метаданных
 * TypeORM. Здесь нужно другое — что посетитель правильно раскладывает лямбду по подзапросу,
 * — и настоящие метаданные только привязали бы тесты к фикстурам.
 *
 * @param known - имена связей, которые резолвер согласен разрешить.
 */
function relationResolver(known: readonly string[]): RelationResolver {
  const source = (childAlias: string, where: string): RelationSource => ({
    from: `related ${childAlias}`,
    where,
    resolveRelation: (navigation, parentAlias, alias) =>
      known.includes(navigation[navigation.length - 1] ?? '')
        ? source(alias, `${alias}.parent_id = ${parentAlias}.id`)
        : undefined,
    column: (property) => `${childAlias}.${property}`,
  });

  return (navigation, parentAlias, childAlias) =>
    known.includes(navigation[navigation.length - 1] ?? '')
      ? source(childAlias, `${childAlias}.parent_id = ${parentAlias}.id`)
      : undefined;
}

/**
 * Типы колонок для приведений: пути от корня, как их отдаёт `executeQuery`.
 *
 * Настоящий резолвер собирается из метаданных TypeORM и проверяется матрицей на трёх СУБД.
 * Здесь проверяется другое — что посетитель спрашивает тип у нужного уровня вложенности.
 */
const COLUMN_EDM_TYPES: Readonly<Record<string, string>> = {
  name: 'Edm.String',
  age: 'Edm.Int32',
  rating: 'Edm.Double',
  birthday: 'Edm.Date',
  createdAt: 'Edm.DateTimeOffset',
  'books/pages': 'Edm.Int32',
};

const resolveColumnType: ColumnTypeResolver = (path) => COLUMN_EDM_TYPES[path];

/** Узел AST, собранный руками: `createFilter` принимает готовый `Token` от вызывающего кода. */
function token(type: TokenType, raw: string, value: Record<string, unknown>): Token {
  return { type, raw, position: 0, next: raw.length, value } as unknown as Token;
}

describe('TypeOrmVisitor', () => {
  function processQuery(
    odataQuery: string,
    options: Partial<SqlOptions> = {},
    table = 'users'
  ): { sql: string; parameters: Map<string, unknown> } {
    const ast = parseQueryOptions(odataQuery);
    const visitor = new TypeOrmVisitor({
      alias: 'u',
      useParameters: true,
      ...options,
    });

    visitor.Visit(ast);

    const sql = visitor.from(table);

    return { sql, parameters: visitor.parameters };
  }

  describe('$select', () => {
    it('должен сгенерировать простой SELECT', () => {
      const { sql } = processQuery('$select=id,name');

      expect(sql).toBe('SELECT u.id, u.name FROM users WHERE 1 = 1 ORDER BY 1');
    });

    it('должен обработать несколько полей через запятую', () => {
      const { sql } = processQuery('$select=id,name,email');

      expect(sql).toMatch(/SELECT u\.id, u\.name, u\.email FROM/);
    });

    it('должен обработать вложенный select (expand relation)', () => {
      const { sql } = processQuery('$select=id,profile/avatar');

      expect(sql).toMatch(/SELECT u\.id, u_profile\.avatar FROM users WHERE/);
    });

    it('должен обработать несколько вложенных select', () => {
      const { sql } = processQuery('$select=id,profile/avatar,profile/bio');

      expect(sql).toMatch(/SELECT u\.id, u_profile\.avatar, u_profile\.bio FROM/);
    });
  });

  describe('$filter', () => {
    it('должен сгенерировать простое равенство', () => {
      const { sql, parameters } = processQuery("$filter=name eq 'John'");

      expect(sql).toContain('WHERE u.name = :p');
      expect(parameters.get('p0')).toBe('John');
    });

    it('должен обработать AND/OR', () => {
      const { sql, parameters } = processQuery("$filter=name eq 'John' and age gt 18");

      expect(sql).toContain('WHERE u.name = :p0 AND u.age > :p1');
      expect(parameters.get('p0')).toBe('John');
      expect(parameters.get('p1')).toBe(18);
    });

    it('должен обработать вложенные пути свойств', () => {
      const { sql, parameters } = processQuery('$filter=profile/age gt 18');

      expect(sql).toContain('WHERE u_profile.age > :p0');
      expect(parameters.get('p0')).toBe(18);
    });

    it('должен обработать глубоко вложенные пути', () => {
      const { sql, parameters } = processQuery("$filter=profile/address/city eq 'Moscow'");

      expect(sql).toContain('WHERE u_profile_address.city = :p0');
      expect(parameters.get('p0')).toBe('Moscow');
    });
  });

  describe('$orderby', () => {
    it('должен сгенерировать ORDER BY', () => {
      const { sql } = processQuery('$orderby=name');

      expect(sql).toContain('ORDER BY u.name');
    });

    it('должен обработать несколько полей сортировки', () => {
      const { sql } = processQuery('$orderby=name desc,age asc');

      expect(sql).toContain('ORDER BY u.name DESC, u.age ASC');
    });

    it('должен обработать вложенную сортировку', () => {
      const { sql } = processQuery('$orderby=Profile/Name');

      expect(sql).toContain('ORDER BY u_Profile.Name');
    });
  });

  describe('$expand', () => {
    it('должен создать include посетители для развёрнутых связей', () => {
      const { sql } = processQuery('$expand=Profile');

      expect(sql).toContain('SELECT * FROM users WHERE 1 = 1 ORDER BY 1');

      const visitor = new TypeOrmVisitor({ alias: 'u', useParameters: true });
      const ast = parseQueryOptions('$expand=Profile');

      visitor.Visit(ast);

      expect(visitor.includes.length).toBe(1);
      expect(visitor.includes[0]!.navigationProperty).toBe('Profile');
    });

    it('должен обработать вложенный expand', () => {
      const visitor = new TypeOrmVisitor({ alias: 'u', useParameters: true });
      const ast = parseQueryOptions('$expand=profile($expand=avatar)');

      visitor.Visit(ast);

      expect(visitor.includes.length).toBe(1);

      const profileVisitor = visitor.includes[0]!;

      expect(profileVisitor.navigationProperty).toBe('profile');
      expect(profileVisitor.includes.length).toBe(1);
      expect(profileVisitor.includes[0]!.navigationProperty).toBe('avatar');
    });
  });

  describe('OData функции', () => {
    describe('contains', () => {
      it('должен сгенерировать LIKE с параметрами', () => {
        const { sql, parameters } = processQuery("$filter=contains(name, 'John')");

        expect(sql).toContain('SELECT * FROM users WHERE u.name LIKE :p0 ORDER BY 1');
        expect(parameters.get('p0')).toBe('%John%');
      });
    });

    describe('startswith', () => {
      it('должен сгенерировать LIKE с суффиксом %', () => {
        const { sql, parameters } = processQuery("$filter=startswith(name, 'Jo')");

        expect(sql).toContain('SELECT * FROM users WHERE u.name LIKE :p0 ORDER BY 1');
        expect(parameters.get('p0')).toBe('Jo%');
      });
    });

    describe('endswith', () => {
      it('должен сгенерировать LIKE с префиксом %', () => {
        const { sql, parameters } = processQuery("$filter=endswith(name, 'hn')");

        expect(sql).toContain('SELECT * FROM users WHERE u.name LIKE :p0 ORDER BY 1');
        expect(parameters.get('p0')).toBe('%hn');
      });
    });

    describe('indexof', () => {
      it('должен сгенерировать ANSI-форму POSITION по умолчанию', () => {
        const { sql } = processQuery("$filter=indexof(name, 'o') eq 2");

        // OData считает позиции с нуля, SQL — с единицы, отсюда `- 1`.
        expect(sql).toContain('WHERE POSITION(:p0 IN u.name) - 1 = :p1');
      });
    });

    describe('substring', () => {
      it('должен сгенерировать SUBSTR со сдвигом на единицу', () => {
        const { sql } = processQuery("$filter=substring(name, 1) eq 'ohn'");

        // OData отсчитывает начало с нуля, SUBSTR — с единицы.
        expect(sql).toContain('WHERE SUBSTR(u.name, :p0 + 1) = :p1');
      });

      it('должен передать третий аргумент как длину', () => {
        const { sql } = processQuery("$filter=substring(name, 0, 2) eq 'Jo'");

        expect(sql).toContain('WHERE SUBSTR(u.name, :p0 + 1, :p1) = :p2');
      });
    });

    describe('concat', () => {
      it('должен сгенерировать ANSI-оператор конкатенации', () => {
        const { sql } = processQuery("$filter=concat(name, '!') eq 'John!'");

        expect(sql).toContain('WHERE (u.name || :p0) = :p1');
      });
    });

    describe('replace', () => {
      it('должен сгенерировать REPLACE с тремя аргументами', () => {
        const { sql, parameters } = processQuery("$filter=replace(name, 'o', '0') eq 'J0hn'");

        expect(sql).toContain('WHERE REPLACE(u.name, :p0, :p1) = :p2');
        expect(parameters.get('p0')).toBe('o');
        expect(parameters.get('p1')).toBe('0');
      });

      it('форма одинакова во всех диалектах', () => {
        // Единственная строковая функция OData без диалектных расхождений: сигнатура
        // REPLACE совпадает во всех пяти СУБД, поэтому switch по диалекту здесь не нужен.
        for (const dialect of ['ansi', 'postgres', 'mysql', 'sqlite', 'mssql', 'oracle']) {
          const { sql } = processQuery("$filter=replace(name, 'o', '0') eq 'J0hn'", { dialect });

          expect(sql).toContain('REPLACE(u.name, :p0, :p1)');
        }
      });

      it('без третьего аргумента запрос отвергается', () => {
        // Иначе в SQL уехал бы REPLACE с двумя аргументами — синтаксическая ошибка,
        // о которой клиент узнал бы уже от СУБД.
        expect(() => processQuery("$filter=replace(name, 'o') eq 'x'")).toThrow(
          ODataUnsupportedError
        );
      });
    });

    describe('totalseconds', () => {
      it('литерал длительности сворачивается в число при компиляции', () => {
        const { sql, parameters } = processQuery("$filter=totalseconds(duration'PT1H') eq 3600");

        // SQL-функции здесь нет вовсе: значение известно до запроса, поэтому выражение
        // работает и в СУБД без типа длительности.
        expect(sql).toContain('WHERE :p0 = :p1');
        expect(parameters.get('p0')).toBe(3600);
      });

      it('отрицательная длительность сохраняет знак', () => {
        const { parameters } = processQuery("$filter=totalseconds(duration'-PT1H') eq -3600");

        expect(parameters.get('p0')).toBe(-3600);
      });

      it('колонка в PostgreSQL даёт EXTRACT(EPOCH)', () => {
        const { sql } = processQuery('$filter=totalseconds(span) gt 60', { dialect: 'postgres' });

        expect(sql).toContain('WHERE EXTRACT(EPOCH FROM u.span) > :p0');
      });

      it('колонка в Oracle складывается из составляющих интервала', () => {
        const { sql } = processQuery('$filter=totalseconds(span) gt 60', { dialect: 'oracle' });

        expect(sql).toContain(
          '(EXTRACT(DAY FROM u.span) * 86400 + EXTRACT(HOUR FROM u.span) * 3600 + ' +
            'EXTRACT(MINUTE FROM u.span) * 60 + EXTRACT(SECOND FROM u.span))'
        );
      });

      it.each(['mysql', 'sqlite', 'mssql', 'ansi'])(
        'колонка в диалекте %s не поддерживается',
        (dialect) => {
          // Типа длительности в этих СУБД нет вовсе, значит и колонки Edm.Duration не бывает.
          // Отказ честнее выдуманной трансляции: считать секунды не из чего.
          expect(() => processQuery('$filter=totalseconds(span) gt 60', { dialect })).toThrow(
            ODataUnsupportedError
          );
        }
      );
    });

    describe('round', () => {
      it('должен сгенерировать ROUND', () => {
        const { sql } = processQuery('$filter=round(price) eq 10');

        expect(sql).toContain('WHERE ROUND(u.price) = :p0');
      });
    });

    describe('length', () => {
      it('должен сгенерировать LENGTH (LEN только в MS SQL)', () => {
        const { sql } = processQuery('$filter=length(name) gt 5');

        expect(sql).toContain('WHERE LENGTH(u.name) > :p0');
      });
    });

    describe('tolower', () => {
      it('должен сгенерировать LOWER', () => {
        const { sql } = processQuery("$filter=tolower(name) eq 'john'");

        expect(sql).toContain('WHERE LOWER(u.name) = :p0');
      });
    });

    describe('toupper', () => {
      it('должен сгенерировать UPPER', () => {
        const { sql } = processQuery("$filter=toupper(name) eq 'JOHN'");

        expect(sql).toContain('WHERE UPPER(u.name) = :p0');
      });
    });

    describe('year/month/day/hour/minute/second', () => {
      it('должен сгенерировать EXTRACT для ANSI-диалекта', () => {
        const { sql } = processQuery('$filter=year(createdAt) eq 2023');

        expect(sql).toContain('WHERE EXTRACT(YEAR FROM u.createdAt) = :p0');
      });
    });

    describe('now', () => {
      it('должен сгенерировать CURRENT_TIMESTAMP', () => {
        const { sql } = processQuery('$filter=createdAt lt now()');

        expect(sql).toContain('WHERE u.createdAt < CURRENT_TIMESTAMP');
      });
    });

    describe('trim', () => {
      it('должен сгенерировать TRIM без указания символа', () => {
        const { sql } = processQuery("$filter=trim(name) eq 'John'");

        expect(sql).toContain('WHERE TRIM(u.name) = :p0');
      });
    });

    describe('cast', () => {
      it.each([
        ['postgres', 'CAST(u.age AS TEXT)'],
        ['mysql', 'CAST(u.age AS CHAR)'],
        ['sqlite', 'CAST(u.age AS TEXT)'],
        ['mssql', 'CAST(u.age AS NVARCHAR(MAX))'],
        ['oracle', 'CAST(u.age AS VARCHAR2(4000))'],
      ])('число в строку в диалекте %s', (dialect, expected) => {
        const { sql } = processQuery("$filter=cast(age,Edm.String) eq '30'", {
          dialect,
          resolveColumnType,
        });

        expect(sql).toContain(expected);
      });

      it('расширение числа даёт CAST к более широкому типу', () => {
        const { sql } = processQuery('$filter=cast(age,Edm.Int64) gt 30', {
          dialect: 'postgres',
          resolveColumnType,
        });

        expect(sql).toContain('CAST(u.age AS BIGINT)');
      });

      it('приведение к собственному типу не даёт CAST вовсе', () => {
        // Приведение существует в запросе, но работы для СУБД в нём нет: тип уже тот.
        const { sql } = processQuery("$filter=cast(name,Edm.String) eq 'Ada'", {
          dialect: 'postgres',
          resolveColumnType,
        });

        expect(sql).toContain('WHERE u.name = :p0');
        expect(sql).not.toContain('CAST');
      });

      it('дата в дату-время в SQLite делается функцией, а не CAST', () => {
        // `CAST('2020-01-15' AS DATETIME)` в SQLite даёт 2020: числовая аффинность
        // разбирает строку до первого нецифрового символа и уничтожает значение.
        const { sql } = processQuery('$filter=cast(birthday,Edm.DateTimeOffset) gt 2020-01-01', {
          dialect: 'sqlite',
          resolveColumnType,
        });

        expect(sql).toContain('datetime(u.birthday)');
      });

      it('тип литерала берётся из дерева, метаданные для него не нужны', () => {
        const { sql } = processQuery("$filter=cast(42,Edm.String) eq '42'", {
          dialect: 'postgres',
        });

        expect(sql).toContain('CAST(:p0 AS TEXT)');
      });

      it('нетотальное приведение отвергается с названием пары типов', () => {
        // Разбор строки в число проваливается на любом нечисловом значении, а вернуть
        // на этом месте `null`, как требует спецификация, в переносимом SQL нечем.
        let caught: ODataUnsupportedError | undefined;

        try {
          processQuery('$filter=cast(name,Edm.Int32) eq 1', {
            dialect: 'postgres',
            resolveColumnType,
          });
        } catch (e) {
          caught = e as ODataUnsupportedError;
        }

        expect(caught).toBeInstanceOf(ODataUnsupportedError);
        expect(caught?.feature).toContain('cast from Edm.String to Edm.Int32');
      });

      it('сужение числа тоже отвергается', () => {
        expect(() =>
          processQuery('$filter=cast(rating,Edm.Int32) eq 4', {
            dialect: 'postgres',
            resolveColumnType,
          })
        ).toThrow(ODataUnsupportedError);
      });

      it('без резолвера типов приведение колонки отвергается', () => {
        // Не зная типа колонки, нельзя решить, может ли CAST провалиться. Догадка здесь
        // означала бы догадку о соответствии спецификации.
        let caught: ODataUnsupportedError | undefined;

        try {
          processQuery("$filter=cast(age,Edm.String) eq '30'", { dialect: 'postgres' });
        } catch (e) {
          caught = e as ODataUnsupportedError;
        }

        expect(caught?.feature).toBe('cast() over an expression of unknown type');
      });

      it('на незнакомом драйвере приведение отвергается', () => {
        // Имена типов в CAST не стандартизованы: угаданное имя дало бы синтаксическую
        // ошибку в каждом запросе.
        let caught: ODataUnsupportedError | undefined;

        try {
          processQuery("$filter=cast(age,Edm.String) eq '30'", {
            dialect: 'ansi',
            resolveColumnType,
          });
        } catch (e) {
          caught = e as ODataUnsupportedError;
        }

        expect(caught?.feature).toBe('cast to Edm.String in dialect "ansi"');
      });

      it('имя типа вне cast отвергается по имени', () => {
        let caught: ODataUnsupportedError | undefined;

        try {
          processQuery('$filter=name eq Edm.String');
        } catch (e) {
          caught = e as ODataUnsupportedError;
        }

        expect(caught?.feature).toBe('type name "Edm.String" outside of cast()');
      });

      it('isof отвергается посетителем, а не парсером', () => {
        // Раньше запрос не проходил грамматику, и в сообщении была позиция символа.
        let caught: ODataUnsupportedError | undefined;

        try {
          processQuery('$filter=isof(name,Edm.String)');
        } catch (e) {
          caught = e as ODataUnsupportedError;
        }

        expect(caught?.feature).toBe('isof()');
      });
    });

    describe('mindatetime / maxdatetime', () => {
      it('нижняя граница уезжает параметром', () => {
        const { sql, parameters } = processQuery('$filter=createdAt ge mindatetime()', {
          dialect: 'postgres',
        });

        expect(sql).toContain('WHERE u.createdAt >= :p0');
        expect(parameters.get('p0')).toEqual(new Date('0001-01-01T00:00:00Z'));
      });

      it('верхняя граница — конец диапазона Edm.DateTimeOffset', () => {
        const { parameters } = processQuery('$filter=createdAt le maxdatetime()', {
          dialect: 'postgres',
        });

        expect(parameters.get('p0')).toEqual(new Date('9999-12-31T23:59:59.999Z'));
      });

      it('в MySQL нижняя граница — начало диапазона DATETIME', () => {
        // Значение вне диапазона MySQL превращает в сравнении в NULL: условие
        // перестало бы выполняться ни для одной строки.
        const { parameters } = processQuery('$filter=createdAt ge mindatetime()', {
          dialect: 'mysql',
        });

        expect(parameters.get('p0')).toEqual(new Date('1000-01-01T00:00:00Z'));
      });

      it('в режиме без параметров граница инлайнится', () => {
        const { sql } = processQuery('$filter=createdAt ge mindatetime()', {
          dialect: 'postgres',
          useParameters: false,
        });

        expect(sql).toContain("u.createdAt >= '0001-01-01 00:00:00.000'");
      });
    });
  });

  describe('Диалекты SQL', () => {
    /**
     * Функции OData не имеют единой SQL-реализации. Раньше подставлялись константы
     * (`LEN`, `YEAR`, `NOW()`), корректные только для MS SQL, из-за чего на PostgreSQL
     * и SQLite запрос падал. Теперь форма выбирается по `dialect`.
     */
    it.each([
      ['ansi', 'length(name) gt 5', 'LENGTH(u.name)'],
      ['postgres', 'length(name) gt 5', 'LENGTH(u.name)'],
      ['mysql', 'length(name) gt 5', 'LENGTH(u.name)'],
      ['sqlite', 'length(name) gt 5', 'LENGTH(u.name)'],
      ['mssql', 'length(name) gt 5', 'LEN(u.name)'],
    ])('length в диалекте %s', (dialect, filter, expected) => {
      const { sql } = processQuery(`$filter=${filter}`, { dialect });

      expect(sql).toContain(expected);
    });

    it.each([
      ['ansi', 'EXTRACT(YEAR FROM u.createdAt)'],
      ['postgres', 'EXTRACT(YEAR FROM u.createdAt)'],
      ['mysql', 'EXTRACT(YEAR FROM u.createdAt)'],
      ['oracle', 'EXTRACT(YEAR FROM u.createdAt)'],
      ['mssql', 'DATEPART(year, u.createdAt)'],
      ['sqlite', "CAST(strftime('%Y', u.createdAt) AS INTEGER)"],
    ])('year в диалекте %s', (dialect, expected) => {
      const { sql } = processQuery('$filter=year(createdAt) eq 2023', { dialect });

      expect(sql).toContain(expected);
    });

    it.each([
      ['ansi', '(EXTRACT(SECOND FROM u.createdAt) - FLOOR(EXTRACT(SECOND FROM u.createdAt)))'],
      ['postgres', '(EXTRACT(SECOND FROM u.createdAt) - FLOOR(EXTRACT(SECOND FROM u.createdAt)))'],
      ['oracle', '(EXTRACT(SECOND FROM u.createdAt) - FLOOR(EXTRACT(SECOND FROM u.createdAt)))'],
      ['mysql', '(MICROSECOND(u.createdAt) / 1000000)'],
      [
        'sqlite',
        "(CAST(strftime('%f', u.createdAt) AS REAL) - CAST(strftime('%S', u.createdAt) AS INTEGER))",
      ],
      ['mssql', '(DATEPART(nanosecond, u.createdAt) / 1000000000.0)'],
    ])('fractionalseconds в диалекте %s', (dialect, expected) => {
      const { sql } = processQuery('$filter=fractionalseconds(createdAt) eq 0', { dialect });

      expect(sql).toContain(expected);
    });

    it.each([
      ['ansi', 'POSITION(:p0 IN u.name)'],
      ['postgres', 'POSITION(:p0 IN u.name)'],
      ['mysql', 'INSTR(u.name, :p0)'],
      ['sqlite', 'INSTR(u.name, :p0)'],
      ['oracle', 'INSTR(u.name, :p0)'],
      ['mssql', 'CHARINDEX(:p0, u.name)'],
    ])('indexof в диалекте %s', (dialect, expected) => {
      const { sql } = processQuery("$filter=indexof(name, 'o') eq 2", { dialect });

      expect(sql).toContain(expected);
    });

    it.each([
      ['ansi', '(u.name || :p0)'],
      ['postgres', '(u.name || :p0)'],
      ['sqlite', '(u.name || :p0)'],
      ['mysql', 'CONCAT(u.name, :p0)'],
      ['mssql', 'CONCAT(u.name, :p0)'],
    ])('concat в диалекте %s', (dialect, expected) => {
      const { sql } = processQuery("$filter=concat(name, '!') eq 'John!'", { dialect });

      expect(sql).toContain(expected);
    });

    it.each([
      ['ansi', 'CEIL(u.price)'],
      ['postgres', 'CEIL(u.price)'],
      ['mysql', 'CEIL(u.price)'],
      ['sqlite', 'CEIL(u.price)'],
      ['mssql', 'CEILING(u.price)'],
    ])('ceiling в диалекте %s', (dialect, expected) => {
      const { sql } = processQuery('$filter=ceiling(price) eq 10', { dialect });

      expect(sql).toContain(expected);
    });

    it.each([
      ['ansi', 'CAST(u.createdAt AS DATE)'],
      ['postgres', 'CAST(u.createdAt AS DATE)'],
      ['mssql', 'CAST(u.createdAt AS DATE)'],
      ['mysql', 'DATE(u.createdAt)'],
      ['sqlite', 'DATE(u.createdAt)'],
    ])('date в диалекте %s', (dialect, expected) => {
      const { sql } = processQuery('$filter=date(createdAt) eq 2020-01-15', { dialect });

      expect(sql).toContain(expected);
    });

    it.each([
      ['ansi', 'CAST(u.createdAt AS TIME)'],
      ['mysql', 'TIME(u.createdAt)'],
      ['sqlite', 'TIME(u.createdAt)'],
    ])('time в диалекте %s', (dialect, expected) => {
      const { sql } = processQuery('$filter=time(createdAt) eq 08:00:00', { dialect });

      expect(sql).toContain(expected);
    });

    /**
     * `Literal.convert` превращает `Edm.TimeOfDay` в полный момент времени
     * (`08:00:00` → `1970-01-01T08:00:00.000Z`), а `TIME(x)` во всех трёх СУБД отдаёт
     * `HH:MM:SS`. Сравнение таких значений никогда не сходилось, поэтому время суток
     * привязывается исходной строкой.
     */
    it('литерал времени суток привязывается строкой HH:MM:SS', () => {
      const { parameters } = processQuery('$filter=time(createdAt) eq 08:00:00');

      expect(parameters.get('p0')).toBe('08:00:00');
    });

    it('литерал даты остаётся строкой YYYY-MM-DD', () => {
      const { parameters } = processQuery('$filter=date(createdAt) eq 2020-01-15');

      expect(parameters.get('p0')).toBe('2020-01-15');
    });

    it('substring в MS SQL получает обязательный третий аргумент', () => {
      const { sql } = processQuery("$filter=substring(name, 1) eq 'ohn'", { dialect: 'mssql' });

      expect(sql).toContain('SUBSTRING(u.name, :p0 + 1, LEN(u.name))');
    });

    it('незнакомый драйвер сводится к ANSI', () => {
      const { sql } = processQuery('$filter=length(name) gt 5', { dialect: 'some-new-driver' });

      expect(sql).toContain('LENGTH(u.name)');
    });

    it('mariadb трактуется как mysql', () => {
      const { sql } = processQuery("$filter=concat(name, '!') eq 'x'", { dialect: 'mariadb' });

      expect(sql).toContain('CONCAT(u.name, :p0)');
    });

    it('better-sqlite3 трактуется как sqlite', () => {
      const { sql } = processQuery('$filter=year(createdAt) eq 2023', {
        dialect: 'better-sqlite3',
      });

      expect(sql).toContain("CAST(strftime('%Y', u.createdAt) AS INTEGER)");
    });
  });

  describe('Логические операторы и арифметика', () => {
    /**
     * Раньше `not` не имел обработчика: базовый посетитель печатал предупреждение в консоль
     * и продолжал обход, из-за чего условие исчезало и запрос возвращал всю таблицу.
     */
    it('not оборачивает выражение в NOT со скобками', () => {
      const { sql } = processQuery("$filter=not (name eq 'John')");

      expect(sql).toContain('WHERE NOT ((u.name = :p0))');
    });

    it.each([
      ['add', '+'],
      ['sub', '-'],
      ['mul', '*'],
      ['div', '/'],
      ['mod', '%'],
    ])('%s транслируется в оператор %s', (odataOperator, sqlOperator) => {
      const { sql } = processQuery(`$filter=age ${odataOperator} 2 eq 10`);

      expect(sql).toContain(`WHERE (u.age ${sqlOperator} :p0) = :p1`);
    });

    it('скобки в арифметике сохраняют группировку', () => {
      const { sql } = processQuery('$filter=(age add 4) mul 2 eq 80');

      // Внешняя пара скобок — от `VisitParenExpression`, внутренняя — от самой операции `add`.
      // Дублирование безвредно и гарантирует, что группировка из OData не потеряется.
      expect(sql).toContain('WHERE (((u.age + :p0)) * :p1) = :p2');
    });
  });

  describe('Неподдерживаемые конструкции', () => {
    /**
     * Ключевое правило: часть запроса не может потеряться незаметно. Клиент, чей фильтр
     * невыполним, обязан получить отказ, а не чужие данные.
     */
    it('неизвестная функция вызывает ODataUnsupportedError', () => {
      expect(() => processQuery('$filter=geo.distance(a, b) lt 1')).toThrow(ODataUnsupportedError);
    });

    it('ошибка содержит имя неподдержанной возможности', () => {
      let caught: ODataUnsupportedError | undefined;

      try {
        processQuery('$filter=geo.distance(a, b) lt 1');
      } catch (e) {
        caught = e as ODataUnsupportedError;
      }

      expect(caught?.feature).toBe('geo.distance()');
      expect(caught?.message).toContain('not supported');
    });

    it('лямбда-оператор без резолвера связей не поддерживается', () => {
      // Подзапрос строится из имени таблицы и колонок соединения, а их знает только слой
      // выполнения. Без `resolveRelation` собрать EXISTS не из чего — и запрос отвергается,
      // а не выполняется без части условия.
      expect(() => processQuery("$filter=posts/any(p: p/title eq 'x')")).toThrow(
        ODataUnsupportedError
      );
    });
  });

  describe('Обработка NULL', () => {
    it('должен заменить = NULL на IS NULL', () => {
      const { sql } = processQuery('$filter=name eq null');

      expect(sql).toContain('WHERE u.name IS NULL');
    });

    it('должен заменить <> NULL на IS NOT NULL', () => {
      const { sql } = processQuery('$filter=name ne null');

      expect(sql).toContain('WHERE u.name IS NOT NULL');
    });
  });

  describe('Параметры', () => {
    it('должен использовать параметры, когда useParameters: true', () => {
      const { sql, parameters } = processQuery("$filter=name eq 'John' and age gt 18", {
        useParameters: true,
      });

      expect(sql).toContain(':p0');
      expect(sql).toContain(':p1');
      expect(parameters.get('p0')).toBe('John');
      expect(parameters.get('p1')).toBe(18);
    });

    it('должен подставлять литералы, когда useParameters: false', () => {
      const { sql, parameters } = processQuery("$filter=name eq 'John' and age gt 18", {
        useParameters: false,
      });

      expect(sql).toContain("u.name = 'John'");
      expect(sql).toContain('u.age > 18');
      expect(parameters.size).toBe(0);
    });
  });

  describe('Логика includes (expand)', () => {
    it('должен создать include посетитель для пути свойства в фильтре', () => {
      const visitor = new TypeOrmVisitor({ alias: 'u', useParameters: true });
      const ast = parseQueryOptions('$filter=Profile/Age gt 18');

      visitor.Visit(ast);

      expect(visitor.includes.length).toBe(1);

      const profileVisitor = visitor.includes[0]!;

      expect(profileVisitor.navigationProperty).toBe('Profile');

      expect(profileVisitor.where).toBe('1 = 1');
      expect(profileVisitor.select).toBe('');
    });

    it('должен повторно использовать существующий include посетитель', () => {
      const visitor = new TypeOrmVisitor({ alias: 'u', useParameters: true });
      const ast = parseQueryOptions('$expand=Profile&$filter=Profile/Age gt 18');

      visitor.Visit(ast);

      expect(visitor.includes.length).toBe(1);

      const profileVisitor = visitor.includes[0]!;

      expect(profileVisitor.navigationProperty).toBe('Profile');
      expect(profileVisitor.where).toBe('1 = 1');
    });
  });

  describe('Метод from()', () => {
    it('должен сгенерировать базовый SELECT без WHERE/ORDER', () => {
      const visitor = new TypeOrmVisitor({ alias: 'u', useParameters: true });
      const sql = visitor.from('users');

      expect(sql).toBe('SELECT  FROM users WHERE  ORDER BY ');
    });

    it('должен включить OFFSET и FETCH, когда указаны skip и limit (числа)', () => {
      const visitor = new TypeOrmVisitor({ alias: 'u', useParameters: true });

      visitor.skip = 10;
      visitor.limit = 20;

      const sql = visitor.from('users');

      expect(sql).toContain('OFFSET 10 ROWS');
      expect(sql).toContain('FETCH NEXT 20 ROWS ONLY');
    });

    it('должен добавить OFFSET 0 ROWS, когда указан limit, но skip отсутствует', () => {
      const visitor = new TypeOrmVisitor({ alias: 'u', useParameters: true });

      visitor.limit = 20;

      const sql = visitor.from('users');

      expect(sql).toContain('OFFSET 0 ROWS');
      expect(sql).toContain('FETCH NEXT 20 ROWS ONLY');
    });

    it('не должен добавлять OFFSET/FETCH, если skip и limit не определены', () => {
      const visitor = new TypeOrmVisitor({ alias: 'u', useParameters: true });
      const sql = visitor.from('users');

      expect(sql).not.toContain('OFFSET');
      expect(sql).not.toContain('FETCH');
    });
  });

  describe('$compute', () => {
    /** Псевдоним и его SQL — то, ради чего опция и существует. */
    function compute(odataQuery: string, options: Partial<SqlOptions> = {}): TypeOrmVisitor {
      const visitor = new TypeOrmVisitor({ alias: 'u', useParameters: true, ...options });

      visitor.Visit(parseQueryOptions(odataQuery));

      return visitor;
    }

    it('имя подставляется скомпилированным SQL в $filter', () => {
      const { sql, parameters } = processQuery(
        '$compute=age mul 2 as doubled&$filter=doubled gt 80'
      );

      expect(sql).toContain('(u.age * :p0) > :p1');
      // :p0 — литерал из $compute: он компилируется раньше $filter, поэтому номер первый.
      expect(parameters.get('p0')).toBe(2);
      expect(parameters.get('p1')).toBe(80);
    });

    it('имя работает и в $orderby', () => {
      // Разбор $compute обязан идти раньше $orderby, иначе имя не нашлось бы —
      // см. queryOptionsSort.
      //
      // В сортировку уходит SQL-псевдоним, а не выражение: выражение в ORDER BY ломает
      // двухшаговую пагинацию TypeORM — он читает `(u.age * :p0)` как алиас `(u`.
      const visitor = compute('$compute=age mul 2 as doubled&$orderby=doubled desc');

      expect(visitor.orderby).toBe('u_doubled DESC');
      expect(visitor.computedOrderBy.get('doubled')).toBe('(u.age * :p0)');
      expect(visitor.computedOrderByAlias('doubled')).toBe('u_doubled');
    });

    it('в $filter подставляется выражение, а не псевдоним', () => {
      // В WHERE ссылаться на псевдоним из SELECT нельзя — там нужно само выражение.
      const visitor = compute('$compute=age mul 2 as doubled&$filter=doubled gt 8');

      expect(visitor.where).toContain('(u.age * :p0) >');
      expect(visitor.computedOrderBy.size).toBe(0);
    });

    it('одно и то же имя в двух местах компилируется один раз', () => {
      // Выражение компилируется при разборе $compute, поэтому параметр в нём один,
      // а не по одному на каждое употребление.
      const { parameters } = processQuery(
        '$compute=age add 1 as next&$filter=next gt 10 and next lt 20'
      );

      expect([...parameters.values()]).toEqual([1, 10, 20]);
    });

    it('имя в $select уходит в computedSelects, а не в список колонок', () => {
      const visitor = compute('$compute=age mul 2 as doubled&$select=id,doubled');

      expect(visitor.select).toBe('u.id');
      expect(visitor.computedSelects).toEqual([{ name: 'doubled', sql: '(u.age * :p0)' }]);
    });

    it('$select только из псевдонимов оставляет select пустым', () => {
      // Слой выполнения отличает этот случай по паре «computedSelects не пуст,
      // select равен умолчанию» и выбирает первичный ключ.
      const visitor = compute('$compute=age mul 2 as doubled&$select=doubled');

      expect(visitor.select).toBe('*');
      expect(visitor.computedSelects.map((item) => item.name)).toEqual(['doubled']);
    });

    it('поля внутри выражения попадают в белый список, а имя псевдонима — нет', () => {
      // Иначе $compute стал бы обходом проверки allowedFields (R-11).
      const visitor = compute('$compute=age mul 2 as doubled&$filter=doubled gt 8');

      expect(visitor.collectReferencedFields()).toEqual(['age']);
      expect(visitor.computedFields.get('doubled')).toEqual(['age']);
    });

    it('выражение компилируется, даже если им никто не воспользовался', () => {
      // Ошибка в неиспользованном выражении иначе прошла бы незамеченной, а поля
      // внутри — мимо белого списка.
      const visitor = compute('$compute=age mul 2 as doubled&$select=id');

      expect(visitor.computed.get('doubled')).toBe('(u.age * :p0)');
      expect(visitor.collectReferencedFields()).toContain('age');
    });

    it('путь через связь создаёт JOIN, как и в $filter', () => {
      const visitor = compute('$compute=profile/height mul 2 as h&$filter=h gt 100');

      expect(visitor.where).toContain('(u_profile.height * :p0)');
      expect(visitor.includes.map((include) => include.navigationProperty)).toEqual(['profile']);
    });

    it('псевдоним виден из тела лямбды', () => {
      const { sql } = processQuery(
        '$compute=age mul 10 as limit&$filter=books/any(b: b/pages gt limit)',
        {
          resolveRelation: relationResolver(['books']),
        }
      );

      expect(sql).toContain('(u.age * :p0)');
    });

    it('столкновение с именем свойства сущности отвергается', () => {
      // Молча выигранное имя означало бы фильтр не по той колонке.
      expect(() =>
        compute('$compute=age mul 2 as name&$select=name', { resolveColumnType })
      ).toThrow(ODataInvalidQueryError);
    });

    it('без resolveColumnType столкновение не проверяется', () => {
      // Прямой вызов createFilter без метаданных: спросить состав сущности не у кого.
      expect(() => compute('$compute=age mul 2 as name&$select=name')).not.toThrow();
    });

    it('повторное имя отвергается', () => {
      expect(() => compute('$compute=age as x, age add 1 as x')).toThrow(ODataInvalidQueryError);
    });

    it('вложенный $compute действует в своей области', () => {
      const visitor = compute('$expand=books($compute=pages mul 2 as p;$filter=p gt 100)');

      expect(visitor.computed.size).toBe(0);
      expect(visitor.includes[0]?.where).toContain('(u_books.pages * :p0) >');
    });
  });

  describe('Лямбда-операторы', () => {
    const resolveRelation = relationResolver(['books', 'reviews']);

    it('any разворачивается в EXISTS с подзапросом по связи', () => {
      const { sql } = processQuery("$filter=books/any(b: b/title eq 'Dune')", {
        resolveRelation,
      });

      expect(sql).toContain('EXISTS (SELECT 1 FROM related u_books_b');
      expect(sql).toContain('u_books_b.parent_id = u.id');
      expect(sql).toContain('u_books_b.title = :p0');
    });

    /**
     * `all` — это отрицание `any` от отрицания условия: «все книги дороже 10» истинно тогда,
     * когда нет книги дешевле. Через `EXISTS` это выражается без размножения корневых строк.
     */
    it('all разворачивается в NOT EXISTS с отрицанием тела', () => {
      const { sql } = processQuery('$filter=books/all(b: b/pages gt 10)', { resolveRelation });

      expect(sql).toContain('NOT EXISTS (SELECT 1 FROM related u_books_b');
      expect(sql).toContain('NOT (u_books_b.pages > :p0)');
    });

    it('лямбда по неизвестной связи отвергается', () => {
      // Резолвер не нашёл связи — значит, подзапрос собрать не из чего. Отдать при этом
      // выборку без условия значило бы вернуть чужие строки.
      let caught: ODataUnsupportedError | undefined;

      try {
        processQuery('$filter=unknown/any(x: x/id eq 1)', { resolveRelation });
      } catch (e) {
        caught = e as ODataUnsupportedError;
      }

      expect(caught).toBeInstanceOf(ODataUnsupportedError);
      expect(caught?.feature).toBe('lambda over an unknown navigation property');
    });

    /**
     * Внутри тела лямбды два источника типов сразу: `b/pages` — колонка книги, `age` —
     * колонка внешней сущности. Один резолвер на оба пути дал бы тип не той сущности,
     * а вместе с ним и неверный ответ на вопрос «может ли приведение провалиться».
     */
    it('тип колонки внутри лямбды берётся от связанной сущности', () => {
      const { sql } = processQuery("$filter=books/any(b: cast(b/pages,Edm.String) eq '100')", {
        dialect: 'postgres',
        resolveRelation,
        resolveColumnType,
      });

      expect(sql).toContain('CAST(u_books_b.pages AS TEXT)');
    });

    it('тип имени без префикса переменной берётся от внешнего уровня', () => {
      const { sql } = processQuery("$filter=books/any(b: cast(age,Edm.String) eq '30')", {
        dialect: 'postgres',
        resolveRelation,
        resolveColumnType,
      });

      expect(sql).toContain('CAST(u.age AS TEXT)');
    });

    it('имя без префикса переменной относится к внешнему уровню', () => {
      const { sql } = processQuery("$filter=books/any(b: name eq 'Ada')", { resolveRelation });

      // `name` — колонка внешней сущности, а не книги: так требует спецификация.
      expect(sql).toContain('u.name = :p0');
      expect(sql).not.toContain('u_books_b.name');
    });

    it('пустой внешний алиас не даёт ведущей точки', () => {
      // Сценарий «сырого» SQL: запрос к одной таблице без алиаса. С пустым `alias`
      // внешнее имя должно остаться голым, а не превратиться в '.name'.
      const ast = parseQueryOptions("$filter=books/any(b: name eq 'Ada')");
      const visitor = new TypeOrmVisitor({ alias: '', useParameters: true, resolveRelation });

      visitor.Visit(ast);

      expect(visitor.where).toContain('name = :p0');
      expect(visitor.where).not.toContain('.name');
    });

    it('путь через связь внутри тела лямбды отвергается', () => {
      expect(() =>
        processQuery("$filter=books/any(b: b/author/name eq 'Ada')", { resolveRelation })
      ).toThrow(ODataUnsupportedError);
    });

    it('повторная лямбда по той же связи не дублирует её в списке', () => {
      const ast = parseQueryOptions('$filter=books/any(b: b/id eq 1) and books/any(c: c/id eq 2)');
      const visitor = new TypeOrmVisitor({ alias: 'u', useParameters: true, resolveRelation });

      visitor.Visit(ast);

      // Список связей лямбд нужен слою выполнения, чтобы не строить для них JOIN дважды.
      expect(visitor.collectNavigationProperties()).toEqual(['books']);
    });

    it('связь вложенной лямбды не дублирует уже известную внешней', () => {
      const ast = parseQueryOptions(
        '$filter=reviews/any(r: r/id eq 1) and books/any(b: b/reviews/any(x: x/id eq 2))'
      );
      const visitor = new TypeOrmVisitor({ alias: 'u', useParameters: true, resolveRelation });

      visitor.Visit(ast);

      expect(visitor.collectNavigationProperties()).toEqual(['reviews', 'books']);
    });

    it('нумерация параметров сквозная между телом лямбды и внешним условием', () => {
      const { parameters } = processQuery(
        "$filter=name eq 'Ada' and books/any(b: b/title eq 'Dune')",
        { resolveRelation }
      );

      // Столкновение `:p0` снаружи и внутри дало бы подстановку чужого значения.
      expect([...parameters.keys()]).toEqual(['p0', 'p1']);
      expect(parameters.get('p1')).toBe('Dune');
    });
  });

  describe('Сравнение двух литералов null', () => {
    /**
     * `null eq null` — вырожденный случай: значение известно ещё при компиляции, а SQL
     * `NULL = NULL` дало бы неопределённость вместо истины.
     */
    it('null eq null сводится к истине', () => {
      const { sql } = processQuery('$filter=null eq null');

      expect(sql).toContain('WHERE 1 = 1');
    });

    it('null ne null сводится ко лжи', () => {
      const { sql } = processQuery('$filter=null ne null');

      expect(sql).toContain('WHERE 1 = 0');
    });
  });

  describe('Готовый AST от вызывающего кода', () => {
    /**
     * `createFilter` принимает не только строку, но и `Token`. Значит, до обхода может дойти
     * дерево, которого наш парсер не порождает, и защиты, снаружи выглядящие лишними,
     * — единственное, что стоит между таким деревом и синтаксически битым SQL.
     */
    function visit(node: Token, options: Partial<SqlOptions> = {}) {
      const visitor = new TypeOrmVisitor({ alias: 'u', useParameters: true, ...options });

      return () => visitor.Visit(node);
    }

    it('узел без обработчика отвергается, а не пропускается', () => {
      expect(visit(token('ApplyExpression' as TokenType, '$apply=…', {}))).toThrow(
        ODataUnsupportedError
      );
    });

    it('вызов функции без обязательного аргумента отвергается', () => {
      const node = token(TokenType.MethodCallExpression, 'contains(name)', {
        method: 'contains',
        parameters: [token(TokenType.ODataIdentifier, 'name', { name: 'name' })],
      });

      let caught: ODataUnsupportedError | undefined;

      try {
        visit(node)();
      } catch (e) {
        caught = e as ODataUnsupportedError;
      }

      expect(caught?.feature).toBe('contains() with 1 argument(s)');
    });

    it('вызов функции без списка аргументов не падает', () => {
      const visitor = new TypeOrmVisitor({ alias: 'u', useParameters: true });

      visitor.Visit(token(TokenType.MethodCallExpression, 'now()', { method: 'now' }));

      expect(visitor.where).toContain('CURRENT_TIMESTAMP');
    });

    it('оператор in без списка значений ни с чем не совпадает', () => {
      const visitor = new TypeOrmVisitor({ alias: 'u', useParameters: true });

      visitor.Visit(token(TokenType.InExpression, 'id in ()', {}));

      expect(visitor.where).toBe('1 = 0');
    });

    it('пустой узел оставляет посетителя в исходном состоянии', () => {
      // Обход пустого узла — не ошибка: у необязательных ветвей AST (`$filter` без
      // предиката) значения нет вовсе. Важно, что посетитель при этом получает умолчания,
      // а не остаётся с пустым WHERE, который склеился бы с соседним фрагментом.
      const visitor = new TypeOrmVisitor({ alias: 'u', useParameters: true });

      expect(() => visitor.Visit(undefined as unknown as Token)).not.toThrow();
      expect(visitor.where).toBe('1 = 1');
    });
  });
});
