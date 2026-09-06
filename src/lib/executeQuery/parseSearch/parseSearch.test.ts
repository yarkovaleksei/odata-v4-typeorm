/**
 * @file Разбор выражения `$search`.
 *
 * Проверяется структура дерева, а не генерируемый SQL: приоритет операторов и неявный `AND`
 * между соседними словами — это ровно то, что раньше терялось, когда строка бралась целиком.
 */
import { ODataInvalidQueryError } from '../../errors';
import { parseSearch, type SearchNode } from './parseSearch';

/** Короткая запись ожидаемого дерева. */
const term = (value: string, phrase = false): SearchNode => ({ type: 'term', value, phrase });
const not = (operand: SearchNode): SearchNode => ({ type: 'not', operand });
const and = (left: SearchNode, right: SearchNode): SearchNode => ({ type: 'and', left, right });
const or = (left: SearchNode, right: SearchNode): SearchNode => ({ type: 'or', left, right });

describe('parseSearch', () => {
  describe('простые случаи', () => {
    it('одно слово', () => {
      expect(parseSearch('ada')).toEqual(term('ada'));
    });

    it('пустая строка — искать нечего', () => {
      expect(parseSearch('')).toBeUndefined();
      expect(parseSearch('   ')).toBeUndefined();
    });

    it('фраза в кавычках ищется целиком', () => {
      expect(parseSearch('"ada lovelace"')).toEqual(term('ada lovelace', true));
    });

    it('в фразе можно экранировать кавычку', () => {
      expect(parseSearch('"he said \\"no\\""')).toEqual(term('he said "no"', true));
    });
  });

  describe('операторы', () => {
    it('соседние слова соединяются через AND', () => {
      expect(parseSearch('ada lovelace')).toEqual(and(term('ada'), term('lovelace')));
    });

    it('явный AND даёт то же дерево', () => {
      expect(parseSearch('ada AND lovelace')).toEqual(and(term('ada'), term('lovelace')));
    });

    it('OR', () => {
      expect(parseSearch('ada OR grace')).toEqual(or(term('ada'), term('grace')));
    });

    it('NOT относится к ближайшему операнду', () => {
      expect(parseSearch('NOT ada')).toEqual(not(term('ada')));
    });

    it('AND сильнее OR', () => {
      // ada OR (grace AND hopper)
      expect(parseSearch('ada OR grace hopper')).toEqual(
        or(term('ada'), and(term('grace'), term('hopper')))
      );
    });

    it('NOT сильнее AND', () => {
      expect(parseSearch('ada NOT lovelace')).toEqual(and(term('ada'), not(term('lovelace'))));
    });

    it('скобки меняют приоритет', () => {
      expect(parseSearch('(ada OR grace) hopper')).toEqual(
        and(or(term('ada'), term('grace')), term('hopper'))
      );
    });

    it('NOT перед скобкой', () => {
      expect(parseSearch('NOT (ada OR grace)')).toEqual(not(or(term('ada'), term('grace'))));
    });

    it('скобка без пробела прерывает слово', () => {
      expect(parseSearch('NOT(ada)')).toEqual(not(term('ada')));
    });
  });

  describe('регистр операторов', () => {
    /**
     * Грамматика OData требует верхний регистр. Иначе `$search=black and white`
     * невозможно было бы найти как есть.
     */
    it('строчное and — обычное слово', () => {
      expect(parseSearch('black and white')).toEqual(
        and(and(term('black'), term('and')), term('white'))
      );
    });

    it('строчное not — обычное слово', () => {
      expect(parseSearch('not')).toEqual(term('not'));
    });
  });

  describe('ошибки', () => {
    it.each([
      ['незакрытая кавычка', '"ada'],
      ['незакрытая скобка', '(ada'],
      ['лишняя закрывающая скобка', 'ada)'],
      ['пустые скобки', '()'],
      ['AND без второго операнда', 'ada AND'],
      ['OR без второго операнда', 'ada OR'],
      ['NOT без операнда', 'NOT'],
      ['AND в начале', 'AND ada'],
    ])('%s', (_name, expression) => {
      expect(() => parseSearch(expression)).toThrow(ODataInvalidQueryError);
    });

    it('в сообщении указан параметр', () => {
      try {
        parseSearch('(ada');
      } catch (error) {
        expect((error as ODataInvalidQueryError).parameter).toBe('$search');
        expect((error as Error).message).toContain('$search');
      }
    });
  });
});
