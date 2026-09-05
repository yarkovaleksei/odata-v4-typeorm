/**
 * @file Типы, специфичные для слоя `executeQuery`: опции вызова и форма ответа при `$count=true`.
 */
import type { ObjectLiteral } from 'typeorm';

/** Опции выполнения запроса. */
export interface ExecuteQueryOptions {
  /**
   * SQL-алиас корневой сущности — префикс колонок в генерируемом SQL.
   *
   * Может быть любым: метаданные сущности берутся из самого `SelectQueryBuilder`
   * (`expressionMap.mainAlias.metadata`), а не по имени алиаса. Привычный TypeORM-стиль
   * `createQueryBuilder('u')` работает.
   *
   * Для `SelectQueryBuilder` можно не задавать — подставится его собственный корневой алиас.
   * Для `Repository` задавайте всегда: иначе построитель получит пустое имя.
   *
   * Запасной путь на случай, когда у построителя нет метаданных (например корень —
   * подзапрос): поиск через `connection.getMetadata(alias)`, и там алиас уже обязан
   * совпадать с именем сущности или таблицы.
   */
  alias?: string;

  /**
   * Верхняя граница `$top`. Запрос с бо́льшим значением обрезается до `maxTop`.
   *
   * Без неё клиент одним запросом вытягивает таблицу целиком, а вместе с `$expand` —
   * ещё и умножает объём выборки. Для публичного API задавайте всегда.
   *
   * @defaultValue без ограничения
   */
  maxTop?: number;

  /**
   * Белый список полей, доступных клиенту через `$select`, `$filter` и `$orderby`.
   *
   * Без него клиент может запросить любое поле сущности, включая служебные.
   * Имена сравниваются с путями свойств (`'name'`, `'author/name'`).
   *
   * @defaultValue разрешены все поля
   */
  allowedFields?: readonly string[];

  /**
   * Белый список связей, доступных через `$expand` и пути в `$filter` / `$orderby`.
   *
   * Проверяется имя связи на каждом уровне вложенности: для `$expand=books($expand=reviews)`
   * в списке должны быть и `books`, и `reviews`.
   *
   * @defaultValue разрешены все связи
   */
  allowedExpands?: readonly string[];
}

/**
 * Ответ при `$count=true`: страница данных и общее число строк по текущим фильтрам
 * (без учёта `$top` / `$skip`).
 *
 * Форма ответа ПО УМОЛЧАНИЮ — обычный массив: по OData v4 (раздел 11.2.5.5) отсутствующий
 * `$count` означает `false`. Объект возвращается, только если клиент явно попросил счётчик.
 * Поэтому возвращаемый тип `executeQuery` — объединение `T[] | GetManyResponse<T>`,
 * и на стороне вызова его нужно сузить.
 *
 * @example
 * const result = await executeQuery(repo, req.query, { alias: 'User' });
 * const items = Array.isArray(result) ? result : result.items;
 */
export interface GetManyResponse<T extends ObjectLiteral> {
  items: T[];
  count: number;
}
