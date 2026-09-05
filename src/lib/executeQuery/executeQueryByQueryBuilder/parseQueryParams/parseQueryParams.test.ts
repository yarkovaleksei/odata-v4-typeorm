import type { ParsedQueryParams, QueryParams } from '../../../types';

import { parseQueryParams } from './parseQueryParams';

describe('parseQueryParams', () => {
  describe('$search', () => {
    it('должен оставить $search как есть, если это непустая строка', () => {
      const query: QueryParams = { $search: 'hello' };
      const result = parseQueryParams(query);

      expect(result.$search).toBe('hello');
    });

    it('должен обрезать пробелы в $search и оставить значение, если после обрезки оно не пустое', () => {
      const query: QueryParams = { $search: '  test  ' };
      const result = parseQueryParams(query);

      expect(result.$search).toBe('test');
    });

    it('должен установить $search в undefined, если передана пустая строка', () => {
      const query: QueryParams = { $search: '' };
      const result = parseQueryParams(query);

      expect(result.$search).toBeUndefined();
    });

    it('должен установить $search в undefined, если строка состоит только из пробелов', () => {
      const query: QueryParams = { $search: '   ' };
      const result = parseQueryParams(query);

      expect(result.$search).toBeUndefined();
    });

    it('должен установить $search в undefined, если $search не передан', () => {
      const query: QueryParams = {};
      const result = parseQueryParams(query);

      expect(result.$search).toBeUndefined();
    });

    it('должен установить $search в undefined, если передан null (хотя тип подразумевает строку)', () => {
      // В реальности QueryParams допускает только string, но для полноты
      const query = { $search: null as never };
      const result = parseQueryParams(query);

      expect(result.$search).toBeUndefined();
    });
  });

  describe('$top', () => {
    it('должен преобразовать строковое число в число', () => {
      const query: QueryParams = { $top: '10' };
      const result = parseQueryParams(query);

      expect(result.$top).toBe(10);
    });

    it('должен оставить число как число', () => {
      const query: QueryParams = { $top: '20' };
      const result = parseQueryParams(query);

      expect(result.$top).toBe(20);
    });

    it('должен установить значение по умолчанию 0, если $top не передан', () => {
      const query: QueryParams = {};
      const result = parseQueryParams(query);

      expect(result.$top).toBe(0);
    });

    it('должен установить значение по умолчанию 0, если $top равен null', () => {
      const query = { $top: null as never };
      const result = parseQueryParams(query);

      expect(result.$top).toBe(0);
    });

    it('должен преобразовать строку "0" в 0', () => {
      const query: QueryParams = { $top: '0' };
      const result = parseQueryParams(query);

      expect(result.$top).toBe(0);
    });

    it('должен обрабатывать отрицательные числа в виде строк', () => {
      const query: QueryParams = { $top: '-5' };
      const result = parseQueryParams(query);

      expect(result.$top).toBe(-5);
    });

    it('должен обрабатывать числа с плавающей точкой в виде строк (parseInt отбрасывает дробную часть)', () => {
      const query: QueryParams = { $top: '3.14' };
      const result = parseQueryParams(query);

      expect(result.$top).toBe(3);
    });
  });

  describe('$skip', () => {
    it('должен преобразовать строковое число в число', () => {
      const query: QueryParams = { $skip: '5' };
      const result = parseQueryParams(query);

      expect(result.$skip).toBe(5);
    });

    it('должен оставить число как число', () => {
      const query: QueryParams = { $skip: '15' };
      const result = parseQueryParams(query);

      expect(result.$skip).toBe(15);
    });

    it('должен установить значение по умолчанию 0, если $skip не передан', () => {
      const query: QueryParams = {};
      const result = parseQueryParams(query);

      expect(result.$skip).toBe(0);
    });

    it('должен установить значение по умолчанию 0, если $skip равен null', () => {
      const query = { $skip: null as never };
      const result = parseQueryParams(query);

      expect(result.$skip).toBe(0);
    });
  });

  describe('$count', () => {
    it('должен установить значение по умолчанию true, если $count не передан', () => {
      const query: QueryParams = {};
      const result = parseQueryParams(query);

      expect(result.$count).toBe(true);
    });

    it('должен оставить булево true', () => {
      const query: QueryParams = { $count: 'true' };
      const result = parseQueryParams(query);

      expect(result.$count).toBe(true);
    });

    it('должен оставить булево false', () => {
      const query: QueryParams = { $count: 'false' };
      const result = parseQueryParams(query);

      expect(result.$count).toBe(false);
    });

    it('должен преобразовать строку "true" в true', () => {
      const query: QueryParams = { $count: 'true' };
      const result = parseQueryParams(query);

      expect(result.$count).toBe(true);
    });

    it('должен преобразовать любую другую строку в false', () => {
      const query: QueryParams = { $count: 'false' };
      const result = parseQueryParams(query);

      expect(result.$count).toBe(false);
    });

    it('должен преобразовать строку "TRUE" в true (регистронезависимо)', () => {
      const query: QueryParams = { $count: 'TRUE' };
      const result = parseQueryParams(query);

      expect(result.$count).toBe(true);
    });

    it('должен преобразовать пустую строку в false', () => {
      const query: QueryParams = { $count: '' };
      const result = parseQueryParams(query);

      expect(result.$count).toBe(false);
    });

    it('должен преобразовать число 1 в false (не булево и не строка "true")', () => {
      const query = { $count: 1 as never };
      const result = parseQueryParams(query);

      expect(result.$count).toBe(false);
    });
  });

  describe('Остальные поля', () => {
    it('должен скопировать $filter, $orderby, $select, $expand без изменений', () => {
      const query: QueryParams = {
        $filter: 'name eq "John"',
        $orderby: 'name desc',
        $select: 'id,name',
        $expand: 'profile',
      };
      const result = parseQueryParams(query);

      expect(result.$filter).toBe(query.$filter);
      expect(result.$orderby).toBe(query.$orderby);
      expect(result.$select).toBe(query.$select);
      expect(result.$expand).toBe(query.$expand);
    });

    it('должен обрабатывать отсутствующие необязательные поля как undefined', () => {
      const query: QueryParams = {};
      const result = parseQueryParams(query);

      expect(result.$filter).toBeUndefined();
      expect(result.$orderby).toBeUndefined();
      expect(result.$select).toBeUndefined();
      expect(result.$expand).toBeUndefined();
    });
  });

  describe('Структура полного объекта', () => {
    it('должен вернуть полный объект ParsedQueryParams с правильными типами', () => {
      const query: QueryParams = {
        $search: '  test  ',
        $filter: 'age gt 18',
        $orderby: 'name',
        $select: 'name,age',
        $expand: 'posts',
        $top: '50',
        $skip: '10',
        $count: 'true',
      };
      const result = parseQueryParams(query);

      expect(result).toEqual({
        $search: 'test',
        $filter: 'age gt 18',
        $orderby: 'name',
        $select: 'name,age',
        $expand: 'posts',
        $top: 50,
        $skip: 10,
        $count: true,
      });
    });

    it('должен сохранять числовые значения, если они уже являются числами', () => {
      const query: ParsedQueryParams = {
        $top: 100,
        $skip: 200,
        $count: false,
      };
      const result = parseQueryParams(query as unknown as QueryParams);

      expect(result.$top).toBe(100);
      expect(result.$skip).toBe(200);
      expect(result.$count).toBe(false);
    });

    it('должен обрабатывать смешанные типы корректно', () => {
      const query: QueryParams = {
        $search: '  search  ',
        $top: 'invalid',
        $skip: '15',
        $count: 'maybe',
      };
      const result = parseQueryParams(query);

      expect(result.$search).toBe('search');
      expect(result.$top).toBe(0);
      expect(result.$skip).toBe(15);
      expect(result.$count).toBe(false);
    });
  });
});
