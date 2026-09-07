import type { ObjectLiteral, SelectQueryBuilder } from 'typeorm';

import { VISITOR_DEFAULTS } from '../../TypeOrmVisitor';
import { applyOrderBy } from './applyOrderBy';

/**
 * Заглушка построителя: записывает аргументы `addOrderBy` и возвращает себя, как это
 * делают методы TypeORM. Настоящий `SelectQueryBuilder` здесь не нужен — проверяется
 * именно разбор строки сортировки, а не поведение TypeORM.
 */
function createQueryBuilderStub() {
  const calls: Array<[string, 'ASC' | 'DESC' | undefined]> = [];

  const stub = {
    calls,
    addOrderBy(field: string, order?: 'ASC' | 'DESC') {
      calls.push([field, order]);

      return stub;
    },
  };

  return stub;
}

/** Приводит заглушку к типу построителя: applyOrderBy пользуется только `addOrderBy`. */
function apply(orderby: string | undefined) {
  const stub = createQueryBuilderStub();

  const result = applyOrderBy(stub as unknown as SelectQueryBuilder<ObjectLiteral>, orderby);

  return { calls: stub.calls, result, stub };
}

describe('applyOrderBy', () => {
  it('не должен добавлять сортировку для пустого значения', () => {
    expect(apply(undefined).calls).toEqual([]);
    expect(apply('').calls).toEqual([]);
  });

  it('не должен добавлять сортировку для значения по умолчанию («$orderby не задан»)', () => {
    expect(apply(VISITOR_DEFAULTS.orderby).calls).toEqual([]);
  });

  it('должен разобрать одно выражение с направлением', () => {
    expect(apply('Author.name ASC').calls).toEqual([['Author.name', 'ASC']]);
  });

  it('должен разобрать несколько выражений через запятую, сохраняя порядок', () => {
    expect(apply('Author.name ASC, Author.id DESC').calls).toEqual([
      ['Author.name', 'ASC'],
      ['Author.id', 'DESC'],
    ]);
  });

  it('должен оставить направление неопределённым, если оно не указано', () => {
    // TypeORM в этом случае подставит ASC сам.
    expect(apply('Author.name').calls).toEqual([['Author.name', undefined]]);
  });

  it('должен пропустить пустой сегмент от лишней запятой', () => {
    // Без этой проверки в ORDER BY уехала бы пустая строка, то есть синтаксическая ошибка SQL.
    expect(apply('Author.name ASC, , Author.id DESC').calls).toEqual([
      ['Author.name', 'ASC'],
      ['Author.id', 'DESC'],
    ]);

    expect(apply(',').calls).toEqual([]);
  });

  it('должен вернуть построитель для сцепления вызовов', () => {
    const { result, stub } = apply('Author.name ASC');

    expect(result).toBe(stub);
  });
});
