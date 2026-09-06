/**
 * @file Тесты `createFilter`.
 *
 * Функция долго оставалась единственным публичным экспортом без единого теста: покрытие
 * файла было 31% строк. При этом именно она — точка входа для сценария «сырой SQL мимо
 * TypeORM», где ошибка не всплывёт ни в каком другом тесте.
 *
 * Ключевое отличие от `createQuery` — точка входа парсера: `parseFilter()` ждёт голое булево
 * выражение (`name eq 'Ann'`), а не строку query options (`$filter=name eq 'Ann'`).
 */
import { parseFilter } from '../odataParser';

import { ODataParseError, ODataUnsupportedError } from '../errors';
import { createFilter } from './createFilter';

describe('createFilter', () => {
  describe('базовая компиляция', () => {
    it('простое равенство', () => {
      const compiled = createFilter("name eq 'Ann'", { alias: 'u' });

      expect(compiled.where).toBe('u.name = :p0');
      expect(compiled.parameters.get('p0')).toBe('Ann');
    });

    it('пустой алиас не добавляет префикс', () => {
      // Основной сценарий «сырого» SQL: запрос к одной таблице без алиаса.
      // Раньше здесь получалось '.Id = :p0' с ведущей точкой — невалидный SQL
      // ровно в том сценарии, ради которого createFilter и существует (дефект A-13).
      const compiled = createFilter('Id eq 42', { alias: '' });

      expect(compiled.where).toBe('Id = :p0');
      expect(compiled.parameters.get('p0')).toBe(42);
    });

    it('пустой алиас в пути по связи не даёт ведущего подчёркивания', () => {
      const compiled = createFilter("author/name eq 'Ann'", { alias: '' });

      expect(compiled.where).toBe('author.name = :p0');
      expect(compiled.includes[0]!.alias).toBe('author');
    });

    it('логическое выражение со скобками', () => {
      const compiled = createFilter("(name eq 'Ann' or name eq 'Bob') and age gt 18", {
        alias: 'u',
      });

      expect(compiled.where).toBe('(u.name = :p0 OR u.name = :p1) AND u.age > :p2');
      expect([...compiled.parameters.values()]).toEqual(['Ann', 'Bob', 18]);
    });

    it('сравнение с null превращается в IS NULL', () => {
      const compiled = createFilter('bio eq null', { alias: 'u' });

      expect(compiled.where).toBe('u.bio IS NULL');
      expect(compiled.parameters.size).toBe(0);
    });

    it('отрицание', () => {
      const compiled = createFilter("not (name eq 'Ann')", { alias: 'u' });

      expect(compiled.where).toBe('NOT ((u.name = :p0))');
    });

    it('арифметика', () => {
      const compiled = createFilter('age add 1 eq 20', { alias: 'u' });

      expect(compiled.where).toBe('(u.age + :p0) = :p1');
    });
  });

  describe('функции и диалекты', () => {
    it('contains использует именованный плейсхолдер', () => {
      const compiled = createFilter("contains(name,'An')", { alias: 'u' });

      expect(compiled.where).toBe('u.name LIKE :p0');
      expect(compiled.parameters.get('p0')).toBe('%An%');
    });

    it('диалект влияет на выбор SQL-функции', () => {
      expect(createFilter('length(name) gt 3', { alias: 'u', dialect: 'mssql' }).where).toContain(
        'LEN(u.name)'
      );
      expect(
        createFilter('length(name) gt 3', { alias: 'u', dialect: 'postgres' }).where
      ).toContain('LENGTH(u.name)');
    });
  });

  describe('пути по связям', () => {
    it('создаёт include для связи и использует его алиас', () => {
      const compiled = createFilter("author/name eq 'Ann'", { alias: 'book' });

      expect(compiled.where).toBe('book_author.name = :p0');
      expect(compiled.includes).toHaveLength(1);
      expect(compiled.includes[0]!.navigationProperty).toBe('author');
      expect(compiled.includes[0]!.alias).toBe('book_author');
      // Связь нужна только для условия — колонки в выборку не идут.
      expect(compiled.includes[0]!.select).toBe('');
    });
  });

  describe('режим без параметров', () => {
    it('литералы инлайнятся в SQL', () => {
      const compiled = createFilter("name eq 'Ann'", { alias: 'u', useParameters: false });

      expect(compiled.where).toBe("u.name = 'Ann'");
      expect(compiled.parameters.size).toBe(0);
    });

    it('LIKE-шаблон тоже инлайнится', () => {
      const compiled = createFilter("contains(name,'An')", { alias: 'u', useParameters: false });

      expect(compiled.where).toBe("u.name LIKE '%An%'");
      expect(compiled.parameters.size).toBe(0);
    });
  });

  describe('готовый AST на входе', () => {
    it('принимает Token и не разбирает строку повторно', () => {
      const ast = parseFilter("name eq 'Ann'");
      const compiled = createFilter(ast, { alias: 'u' });

      expect(compiled.where).toBe('u.name = :p0');
    });
  });

  describe('ошибки', () => {
    it('некорректное выражение даёт ODataParseError с позицией', () => {
      let caught: ODataParseError | undefined;

      try {
        createFilter('!!!', { alias: 'u' });
      } catch (e) {
        caught = e as ODataParseError;
      }

      expect(caught).toBeInstanceOf(ODataParseError);
      expect(caught?.isClientError).toBe(true);
      expect(caught?.source).toBe('!!!');
      expect(caught?.position).toBe(0);
    });

    it('строка с префиксом $filter= не принимается', () => {
      // Типичная ошибка вызова: сюда идёт голое выражение, а не query option.
      expect(() => createFilter("$filter=name eq 'Ann'", { alias: 'u' })).toThrow(ODataParseError);
    });

    it('неподдерживаемая функция даёт ODataUnsupportedError', () => {
      expect(() => createFilter('geo.distance(a,b) lt 1', { alias: 'u' })).toThrow(
        ODataUnsupportedError
      );
    });

    /**
     * Разбор рекурсивный, поэтому достаточно глубокая вложенность исчерпывает стек.
     * `RangeError` — не `ODataError`, и без обёртки он ушёл бы наружу как внутренний сбой:
     * обработчик ответил бы `500` и позвал `next`, то есть строка из запроса роняла бы
     * запрос в системы наблюдения. Это клиентская ошибка, и код у неё клиентский.
     */
    it('запредельная вложенность даёт клиентскую ошибку, а не внутренний сбой', () => {
      const deep = '('.repeat(20_000) + "name eq 'Ann'" + ')'.repeat(20_000);

      let caught: ODataParseError | undefined;

      try {
        createFilter(deep, { alias: 'u' });
      } catch (e) {
        caught = e as ODataParseError;
      }

      expect(caught).toBeInstanceOf(ODataParseError);
      expect(caught?.isClientError).toBe(true);
      expect(caught?.cause).toBeInstanceOf(RangeError);
    });

    it('ошибка обхода не подменяется на ODataParseError', () => {
      // Выражение разобралось, споткнулась трансляция — тип ошибки должен это отражать.
      let caught: unknown;

      try {
        createFilter('geo.distance(a,b) lt 1', { alias: 'u' });
      } catch (e) {
        caught = e;
      }

      expect(caught).not.toBeInstanceOf(ODataParseError);
    });
  });

  describe('интеграция с сырым SQL', () => {
    it('where и parameters пригодны для подстановки в запрос', () => {
      const compiled = createFilter("status eq 'active' and age ge 18", { alias: 't' });

      const sql = `SELECT * FROM users t WHERE ${compiled.where}`;

      expect(sql).toBe('SELECT * FROM users t WHERE t.status = :p0 AND t.age >= :p1');
      expect(Object.fromEntries(compiled.parameters)).toEqual({ p0: 'active', p1: 18 });
    });
  });
});
