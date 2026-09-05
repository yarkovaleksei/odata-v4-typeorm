/**
 * @file Помощники для матрицы совместимости с OData.
 *
 * Матрица описывается таблицами «запрос → ожидаемые id», а не ручными `expect` на каждый случай:
 * так добавление нового оператора стоит одну строку, а вся таблица читается как спецификация
 * поддерживаемого подмножества OData.
 */
import type { ObjectLiteral, Repository } from 'typeorm';

import { executeQuery } from '../../lib/executeQuery';
import type { QueryParams } from '../../lib/types';
import { Author, Book, Review } from '../entity';
import { dataSource } from '../setup/dataSource';
import { testDatabase, type TestDatabase } from '../setup/testDatabase';

/**
 * Выполняет OData-запрос и возвращает идентификаторы найденных строк в порядке выдачи.
 *
 * Сравнение именно по id, а не по объектам целиком: ожидания в таблицах остаются короткими
 * и не ломаются при добавлении колонок в фикстуры.
 */
export async function ids<T extends ObjectLiteral>(
  repository: Repository<T>,
  query: QueryParams,
  alias: string
): Promise<number[]> {
  const result = await executeQuery(repository, query, { alias });
  const items = Array.isArray(result) ? result : result.items;

  return items.map((item) => (item as ObjectLiteral).id as number);
}

/** То же, но по сущности {@link Author} — самый частый случай в таблицах. */
export function authorIds(query: QueryParams): Promise<number[]> {
  return ids(dataSource.getRepository(Author), query, 'Author');
}

/** То же по {@link Book}. */
export function bookIds(query: QueryParams): Promise<number[]> {
  return ids(dataSource.getRepository(Book), query, 'Book');
}

/** То же по {@link Review}. */
export function reviewIds(query: QueryParams): Promise<number[]> {
  return ids(dataSource.getRepository(Review), query, 'Review');
}

/** Полный результат без приведения к id — когда проверяется форма ответа или связи. */
export async function rows<T extends ObjectLiteral>(
  repository: Repository<T>,
  query: QueryParams,
  alias: string
): Promise<T[]> {
  const result = await executeQuery(repository, query, { alias });

  return Array.isArray(result) ? result : result.items;
}

/**
 * Одна строка матрицы: OData-выражение и множество идентификаторов, которое обязано вернуться.
 *
 * `sorted: false` (по умолчанию) сравнивает без учёта порядка — порядок без `$orderby`
 * не определён спецификацией. Для тестов сортировки ставится `sorted: true`.
 */
export interface MatrixCase {
  /** Человекочитаемое название; попадает в вывод Jest. */
  readonly name: string;
  /** Параметры запроса. */
  readonly query: QueryParams;
  /** Ожидаемые идентификаторы. */
  readonly expected: number[];
  /** Учитывать порядок элементов. */
  readonly sorted?: boolean;
  /**
   * СУБД, на которых случай не проверяется, с причиной.
   *
   * Нужен там, где расхождение — свойство самой СУБД, а не дефект библиотеки: скажем,
   * PostgreSQL не выводит типы для выражения из двух безымянных плейсхолдеров.
   * Пропуск всегда сопровождается пояснением — иначе через полгода не отличить
   * осознанное исключение от забытого «почини потом».
   */
  readonly skipOn?: Partial<Record<TestDatabase, string>>;
}

/**
 * Разворачивает таблицу случаев в набор тестов Jest.
 *
 * @param run - как выполнить запрос (обычно {@link authorIds} или {@link bookIds}).
 * @param cases - таблица случаев.
 */
export function runMatrix(
  run: (query: QueryParams) => Promise<number[]>,
  cases: readonly MatrixCase[]
): void {
  it.each(cases.map((c) => [c.name, c] as const))('%s', async (_name, testCase) => {
    const skipReason = testCase.skipOn?.[testDatabase];

    if (skipReason) {
      // Явное сообщение вместо тихого пропуска: в выводе видно, что случай не проверялся.
      console.warn(`пропуск на ${testDatabase}: ${testCase.name} — ${skipReason}`);

      return;
    }

    const actual = await run(testCase.query);

    if (testCase.sorted) {
      expect(actual).toEqual(testCase.expected);
    } else {
      expect([...actual].sort((a, b) => a - b)).toEqual(
        [...testCase.expected].sort((a, b) => a - b)
      );
    }
  });
}

/**
 * Проверяет, что запрос отвергается — синтаксис не разбирается либо возможность
 * не поддерживается. Используется для случаев, где корректное поведение — явная ошибка,
 * а не тихая выдача неверных данных.
 */
export async function expectRejected(
  run: (query: QueryParams) => Promise<unknown>,
  query: QueryParams
): Promise<Error> {
  let caught: Error | undefined;

  try {
    await run(query);
  } catch (e) {
    caught = e as Error;
  }

  if (!caught) {
    throw new Error(`Ожидалась ошибка для запроса ${JSON.stringify(query)}, но её не было`);
  }

  return caught;
}
