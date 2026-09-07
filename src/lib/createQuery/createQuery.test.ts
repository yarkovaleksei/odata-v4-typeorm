/**
 * @file Тесты `createQuery`.
 *
 * Функция компилирует одну строку query options (весь запрос целиком, включая $filter,
 * $select и т.д.) в объект для TypeORM. Тесты проверяют, что опции распарсиваются и
 * собираются правильно, плюс edge cases ошибок.
 */
import { ODataParseError, ODataUnsupportedError } from '../errors';
import { parseQueryOptions } from '../odataParser';
import { createQuery } from './createQuery';

describe('createQuery', () => {
  describe('базовая компиляция', () => {
    it('$filter раскладывается в where', () => {
      const compiled = createQuery("$filter=name eq 'Ann'", { alias: 'u' });

      expect(compiled.where).toBe('u.name = :p0');
      expect(compiled.parameters.get('p0')).toBe('Ann');
    });

    it('$select раскладывается в select', () => {
      const compiled = createQuery('$select=id,name', { alias: 'u' });

      expect(compiled.select).toContain('u.id');
      expect(compiled.select).toContain('u.name');
    });

    it('несколько опций комбинируются', () => {
      const compiled = createQuery('$filter=age gt 18&$select=id,name&$top=10', { alias: 'u' });

      expect(compiled.where).toBe('u.age > :p0');
      expect(compiled.limit).toBe(10);
      expect(compiled.select).toContain('u.id');
    });
  });

  /**
   * Вторая половина сигнатуры: на вход принимается и готовый `Token`. Нужна тем, кто уже
   * разобрал строку сам — например разбирает её один раз, а компилирует под несколько
   * алиасов или диалектов. Повторный разбор в этом случае не выполняется, и результат
   * обязан совпадать с компиляцией той же строки.
   */
  describe('готовый AST вместо строки', () => {
    it('принимается наравне со строкой и даёт тот же результат', () => {
      const source = "$filter=name eq 'Ann'&$select=id,name";
      const fromAst = createQuery(parseQueryOptions(source), { alias: 'u' });
      const fromString = createQuery(source, { alias: 'u' });

      expect(fromAst.where).toBe(fromString.where);
      expect(fromAst.select).toBe(fromString.select);
      expect([...fromAst.parameters]).toEqual([...fromString.parameters]);
    });

    it('один разобранный запрос компилируется под разные алиасы', () => {
      const ast = parseQueryOptions('$filter=age gt 18');

      expect(createQuery(ast, { alias: 'a' }).where).toBe('a.age > :p0');
      expect(createQuery(ast, { alias: 'b' }).where).toBe('b.age > :p0');
    });
  });

  describe('ошибки', () => {
    it('синтаксическая ошибка в $filter', () => {
      expect(() => createQuery('$filter=!!!', { alias: 'u' })).toThrow(ODataParseError);
    });

    it('неподдерживаемая функция', () => {
      expect(() => createQuery('$filter=geo.distance(a,b) lt 1', { alias: 'u' })).toThrow(
        ODataUnsupportedError
      );
    });

    it('невалидная опция $orderby', () => {
      expect(() => createQuery('$orderby=', { alias: 'u' })).toThrow(ODataParseError);
    });

    it('неизвестная system query option отвергается', () => {
      expect(() => createQuery('$unknown=value', { alias: 'u' })).toThrow(ODataParseError);
    });

    /**
     * Разбор рекурсивный, и достаточно глубокая вложенность исчерпывает стек. `RangeError`
     * не относится к типизированным ошибкам библиотеки, поэтому без обёртки ушёл бы наружу
     * как внутренний сбой: `500` и вызов `next` — то есть строка из запроса роняла бы
     * запрос в системы наблюдения.
     */
    it('запредельная вложенность даёт клиентскую ошибку, а не внутренний сбой', () => {
      const deep = '('.repeat(20_000) + 'id eq 1' + ')'.repeat(20_000);

      let caught: ODataParseError | undefined;

      try {
        createQuery(`$filter=${deep}`, { alias: 'u' });
      } catch (e) {
        caught = e as ODataParseError;
      }

      expect(caught).toBeInstanceOf(ODataParseError);
      expect(caught?.isClientError).toBe(true);
      expect(caught?.cause).toBeInstanceOf(RangeError);
    });
  });
});
