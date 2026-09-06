import { query } from 'odata-v4-parser';

import { ODataUnsupportedError } from '../errors';
import type { SqlOptions } from '../types';
import { TypeOrmVisitor } from './TypeOrmVisitor';

describe('TypeOrmVisitor', () => {
  function processQuery(
    odataQuery: string,
    options: Partial<SqlOptions> = {},
    table = 'users'
  ): { sql: string; parameters: Map<string, unknown> } {
    const ast = query(odataQuery);
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
      const ast = query('$expand=Profile');

      visitor.Visit(ast);

      expect(visitor.includes.length).toBe(1);
      expect(visitor.includes[0]!.navigationProperty).toBe('Profile');
    });

    it('должен обработать вложенный expand', () => {
      const visitor = new TypeOrmVisitor({ alias: 'u', useParameters: true });
      const ast = query('$expand=profile($expand=avatar)');

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

    it('лямбда-оператор any не поддерживается', () => {
      // Парсер 0.1.29 теряет тело лямбды, поэтому корректно выполнить такой фильтр нельзя.
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
      const ast = query('$filter=Profile/Age gt 18');

      visitor.Visit(ast);

      expect(visitor.includes.length).toBe(1);

      const profileVisitor = visitor.includes[0]!;

      expect(profileVisitor.navigationProperty).toBe('Profile');

      expect(profileVisitor.where).toBe('1 = 1');
      expect(profileVisitor.select).toBe('');
    });

    it('должен повторно использовать существующий include посетитель', () => {
      const visitor = new TypeOrmVisitor({ alias: 'u', useParameters: true });
      const ast = query('$expand=Profile&$filter=Profile/Age gt 18');

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
});
