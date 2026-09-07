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

  for (const item of orderby.split(',')) {
    // Посетитель нормализует направление к верхнему регистру, так что split по пробелу
    // даёт ['Author.name', 'ASC']. Для поля без направления order будет undefined —
    // TypeORM в этом случае подставит ASC.
    const [field, order] = item.trim().split(' ');

    // Пустой сегмент возможен при лишней запятой в $orderby; добавлять его в ORDER BY
    // нельзя — получится синтаксическая ошибка SQL.
    if (!field) {
      continue;
    }

    result = result.addOrderBy(field, order as 'ASC' | 'DESC');
  }

  return result;
}
