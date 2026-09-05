import type { QueryParams } from '../../types';
import { queryToOdataString } from './queryToOdataString';

describe('queryToOdataString', () => {
  it('должен вернуть пустую строку для пустого объекта запроса', () => {
    const result = queryToOdataString({});

    expect(result).toBe('');
  });

  it('должен игнорировать ключи, которые не начинаются с "$"', () => {
    const query: QueryParams & { [key: string]: string | number } = {
      $search: 'test',
      customParam: 'ignore',
      another: 123,
    };
    const result = queryToOdataString(query);

    expect(result).toBe('$search=test');
  });

  it('должен обрабатывать единственный параметр $search', () => {
    const query: QueryParams = { $search: 'hello' };
    const result = queryToOdataString(query);

    expect(result).toBe('$search=hello');
  });

  it('должен обрабатывать несколько параметров с префиксом "$"', () => {
    const query: QueryParams = {
      $search: 'hello',
      $filter: 'name eq "John"',
      $top: '10',
      $skip: '5',
      $count: 'true',
    };
    const result = queryToOdataString(query);

    expect(result).toContain('$search=hello');
    expect(result).toContain('$filter=name%20eq%20%22John%22');
    expect(result).toContain('$top=10');
    expect(result).toContain('$skip=5');
    expect(result).toContain('$count=true');
    expect(result.split('&').length).toBe(5);
  });

  it('должен игнорировать параметры со значениями null или undefined', () => {
    const query: QueryParams = {
      $search: 'keep',
      // @ts-ignore
      $filter: null,
      $orderby: undefined,
      $top: '0',
    };
    const result = queryToOdataString(query);

    expect(result).toBe('$search=keep&$top=0');
  });

  it('должен корректно кодировать URI-компоненты', () => {
    const query: QueryParams = {
      $search: 'hello world',
      $filter: 'price gt 100',
      $expand: 'products($select=id,name)',
    };
    const result = queryToOdataString(query);

    expect(result).toBe(
      '$search=hello%20world&$filter=price%20gt%20100&$expand=products($select=id,name)'
    );
  });

  it('должен преобразовывать числовые и булевы значения в строки', () => {
    const query: QueryParams = {
      $top: '5',
      $skip: '0',
      $count: 'false',
    };
    const result = queryToOdataString(query);

    expect(result).toBe('$top=5&$skip=0&$count=false');
  });

  it('должен обрабатывать числовые значения, переданные как строки', () => {
    const query: QueryParams = {
      $top: '10',
      $skip: '20',
    };
    const result = queryToOdataString(query);

    expect(result).toBe('$top=10&$skip=20');
  });

  it('должен обрабатывать специальные символы в ключах (хотя ключи предопределены)', () => {
    const query = {
      '$special-key@': 'value',
    } as QueryParams;
    const result = queryToOdataString(query);

    expect(result).toBe('$special-key@=value');
  });

  it('не должен включать параметры, где ключ начинается с "$", но значение ложное (кроме 0, false, пустой строки)', () => {
    const query: QueryParams = {
      $top: '0',
      $skip: '',
      $count: 'false',
      // @ts-ignore
      $filter: null,
    };
    const result = queryToOdataString(query);

    expect(result).toContain('$top=0');
    expect(result).toContain('$skip=');
    expect(result).toContain('$count=false');
    expect(result.split('&').length).toBe(3);
  });

  it('должен вернуть пустую строку, если все параметры с "$" имеют значения null/undefined', () => {
    const query: QueryParams = {
      // @ts-ignore
      $search: null,
      $filter: undefined,
    };
    const result = queryToOdataString(query);

    expect(result).toBe('');
  });

  it('должен сохранять порядок параметров в том виде, в каком они указаны в объекте (согласно спецификации ES)', () => {
    const query: QueryParams = {
      $orderby: 'name',
      $search: 'test',
      $top: '10',
    };
    const result = queryToOdataString(query);

    expect(result).toBe('$orderby=name&$search=test&$top=10');
  });
});
