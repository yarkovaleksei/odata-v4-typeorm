/**
 * @file Запасной путь вложенной пагинации `$expand=books($top=2;$skip=1)`: срез над деревом
 * загруженных сущностей.
 *
 * ОСНОВНОЙ ПУТЬ — В SQL. Страницу вырезает условие с оконной функцией, дописанное к `ON`
 * соединения связи (см. `buildNestedPageCondition`): из базы поднимается только запрошенная
 * страница. Модуль здесь работает там, где так сделать нельзя:
 *
 * - у драйвера нет оконных функций (незнакомая СУБД) либо перенос отключён опцией
 *   `nestedPaginationInSql: false`;
 * - вложенный `$filter` или `$orderby` ссылается на соседнюю связь, алиаса которой
 *   в подзапросе не существует.
 *
 * Результат в обоих случаях одинаковый: вложенный `$orderby` отрабатывает в SQL, поэтому
 * к моменту среза порядок внутри каждого родителя уже правильный.
 *
 * ЧЕМ ПЛАТИМ ЗДЕСЬ: из базы поднимаются все связанные строки, а не только нужная страница.
 * Для связи с десятками записей на родителя это незаметно; для связи с тысячами — ощутимо.
 *
 * Связи, страницу которых уже вырезал SQL, передаются в `paginated` и пропускаются: повторный
 * срез применил бы `$skip` второй раз, к уже урезанной коллекции, и вернул бы пустоту.
 */
import type { ObjectLiteral } from 'typeorm';

import type { TypeOrmVisitor } from '../../TypeOrmVisitor';

/**
 * Применяет вложенные `$top` / `$skip` к дереву загруженных сущностей.
 *
 * Мутирует переданные сущности на месте: они только что созданы гидрацией TypeORM
 * и никому больше не принадлежат, поэтому копировать дерево целиком незачем.
 *
 * @param entities - корневые сущности из `getMany()`.
 * @param includes - дерево include-посетителей (`odataQuery.includes`).
 * @param paginated - связи, страницу которых уже вырезал SQL; их срез пропускается,
 *   но обход уходит вглубь — ограничение может стоять на связи следующего уровня.
 * @returns те же сущности, для удобства сцепления вызовов.
 *
 * @example
 * // $expand=books($top=2;$skip=1) — у каждого автора останутся книги с 2-й по 3-ю
 * applyNestedPagination(authors, odataQuery.includes);
 */
export function applyNestedPagination<T extends ObjectLiteral>(
  entities: T[],
  includes: readonly TypeOrmVisitor[],
  paginated: ReadonlySet<TypeOrmVisitor> = new Set()
): T[] {
  trimLevel(entities, includes, paginated);

  return entities;
}

/**
 * Обходит один уровень сущностей и применяет срез к каждой связи этого уровня.
 *
 * Рекурсия идёт по дереву include, а не по сущностям: связей всегда на порядки меньше,
 * чем строк, поэтому цикл по связям снаружи, а по сущностям — внутри.
 */
function trimLevel(
  entities: readonly ObjectLiteral[],
  includes: readonly TypeOrmVisitor[],
  paginated: ReadonlySet<TypeOrmVisitor>
): void {
  if (!includes.length) {
    return;
  }

  for (const entity of entities) {
    // Гидрация TypeORM оставляет null у связи «многие-к-одному» без записи.
    if (!entity) {
      continue;
    }

    for (const include of includes) {
      trimRelation(entity, include, paginated);
    }
  }
}

/**
 * Применяет срез к одной связи и уходит вглубь.
 *
 * Коллекция (`OneToMany` / `ManyToMany`) режется; одиночная связь (`ManyToOne` / `OneToOne`)
 * не режется никогда — `$top` для неё бессмыслен, — но в неё всё равно нужно спуститься:
 * ограничение может стоять на связи следующего уровня.
 */
function trimRelation(
  entity: ObjectLiteral,
  include: TypeOrmVisitor,
  paginated: ReadonlySet<TypeOrmVisitor>
): void {
  const value = entity[include.navigationProperty];

  if (Array.isArray(value)) {
    const trimmed = paginated.has(include) ? value : sliceRelation(value, include);

    entity[include.navigationProperty] = trimmed;

    trimLevel(trimmed, include.includes, paginated);

    return;
  }

  if (value && typeof value === 'object') {
    trimLevel([value as ObjectLiteral], include.includes, paginated);
  }
}

/**
 * Вырезает запрошенную страницу из коллекции связанных записей.
 *
 * Значения приходят из базового посетителя, где `limit` и `skip` объявлены как `number`,
 * но в отсутствие опции остаются `undefined` — отсюда проверка через `typeof`.
 *
 * `$top=0` даёт пустую коллекцию, как и на верхнем уровне: по OData v4 (раздел 11.2.6.4)
 * это корректный запрос пустой страницы, а не «ограничения нет».
 */
function sliceRelation(items: readonly ObjectLiteral[], include: TypeOrmVisitor): ObjectLiteral[] {
  const hasSkip = typeof include.skip === 'number';
  const hasLimit = typeof include.limit === 'number';

  if (!hasSkip && !hasLimit) {
    // Копию всё равно не делаем: массив остаётся тем же, что вернула гидрация.
    return items as ObjectLiteral[];
  }

  const start = hasSkip ? (include.skip as number) : 0;
  const end = hasLimit ? start + (include.limit as number) : undefined;

  return items.slice(start, end);
}
