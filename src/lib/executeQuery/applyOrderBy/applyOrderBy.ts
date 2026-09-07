/**
 * @file Перенос скомпилированного `$orderby` в `addOrderBy` построителя.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ. Сортировку накладывают два места — корневой запрос
 * (`executeQueryByQueryBuilder`) и каждая связь `$expand` (`processIncludes`), — и делали это
 * одинаковым по смыслу, но отдельно написанным циклом: разбить по запятой, обрезать пробелы,
 * отделить направление, пропустить пустой сегмент. Разъехаться такие копии могут молча:
 * потерянная проверка на пустой сегмент — это `ORDER BY ,` и падение запроса, а забытый разбор
 * направления — тихо перевёрнутый порядок выдачи.
 *
 * ВЕЗДЕ `addOrderBy`, А НЕ `orderBy`: сортировки корня и всех связей накапливаются в одном
 * `ORDER BY`, и порядок их добавления значим — корневая обязана идти первой, иначе сортировка
 * связи начнёт управлять порядком корневых строк (см. `executeQueryByQueryBuilder`, дефект A-14).
 */
import type { ObjectLiteral, SelectQueryBuilder } from 'typeorm';

import { VISITOR_DEFAULTS } from '../../TypeOrmVisitor';

/**
 * Разбивает список сортировки по запятым **верхнего уровня**.
 *
 * Простой `split(',')` разрезал бы и аргументы функции: `$orderby=concat(name,bio)` на MySQL
 * компилируется в `CONCAT(Author.name, Author.bio)`, и половинки уехали бы в `ORDER BY`
 * отдельными выражениями. Поэтому запятая считается разделителем только вне скобок.
 */
function splitTopLevel(orderby: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let current = '';

  for (const character of orderby) {
    if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth -= 1;
    } else if (character === ',' && depth === 0) {
      items.push(current);
      current = '';

      continue;
    }

    current += character;
  }

  items.push(current);

  return items;
}

/**
 * Отделяет направление сортировки от выражения.
 *
 * Направление ищется в конце строки, а не первым пробелом: выражение само по себе бывает
 * с пробелами — `EXTRACT(YEAR FROM Author.registeredAt)` у `$orderby=year(…)`, `(Author.price
 * * Author.qty)` у псевдонима `$compute`. Разбор по первому пробелу отдавал в `ORDER BY`
 * обрубок вроде `EXTRACT(YEAR` и направление `FROM`.
 *
 * Регистр не важен, а наружу направление уходит в верхнем: TypeORM сверяет его со списком
 * `['ASC', 'DESC']` и на `'asc'` бросает `TypeORMError`. Посетитель пишет верхний регистр сам,
 * но фрагмент сюда попадает и от вызывающего кода напрямую.
 */
function splitDirection(item: string): { field: string; order?: 'ASC' | 'DESC' } {
  for (const order of ['ASC', 'DESC'] as const) {
    const suffix = ` ${order}`;

    if (item.toUpperCase().endsWith(suffix)) {
      return { field: item.slice(0, -suffix.length).trim(), order };
    }
  }

  return { field: item };
}

/**
 * Дописывает выражения `$orderby` в `ORDER BY` построителя.
 *
 * @param queryBuilder - построитель; сортировка добавляется через `addOrderBy`, поэтому
 *   уже накопленный порядок сохраняется.
 * @param orderby - скомпилированное посетителем выражение вида
 *   `'Author.name ASC, Author.id DESC'`. Значение по умолчанию (`'1'`, то есть «`$orderby`
 *   не задан») и пустая строка не добавляют ничего.
 * @returns тот же построитель — методы TypeORM возвращают `this`, но переприсваивание
 *   в вызывающем коде сохранено явно.
 *
 * @example
 * applyOrderBy(queryBuilder, 'Author.name ASC, Author.id DESC');
 */
export function applyOrderBy<T extends ObjectLiteral>(
  queryBuilder: SelectQueryBuilder<T>,
  orderby: string | undefined
): SelectQueryBuilder<T> {
  if (!orderby || orderby === VISITOR_DEFAULTS.orderby) {
    return queryBuilder;
  }

  let result = queryBuilder;

  for (const item of splitTopLevel(orderby)) {
    // Направление посетитель нормализует к верхнему регистру и пишет в конец; для поля без
    // направления order будет undefined — TypeORM в этом случае подставит ASC.
    const { field, order } = splitDirection(item.trim());

    // Пустой сегмент возможен при лишней запятой в $orderby; добавлять его в ORDER BY
    // нельзя — получится синтаксическая ошибка SQL.
    if (!field) {
      continue;
    }

    result = result.addOrderBy(field, order);
  }

  return result;
}
