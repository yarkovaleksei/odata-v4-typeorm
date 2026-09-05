/**
 * @file Пагинация внутри `$expand`: `$expand=books($top=2;$skip=1)`.
 *
 * ПОЧЕМУ ПОСЛЕ ЗАПРОСА, А НЕ В SQL
 *
 * Связи загружаются одним запросом через `LEFT JOIN`, поэтому ограничить число связанных
 * строк на каждого родителя средствами того же запроса нельзя: `LIMIT` в нём действует
 * на весь плоский результат, а не на группу. Правильное решение на стороне СУБД —
 * оконная функция `ROW_NUMBER() OVER (PARTITION BY <внешний ключ> ORDER BY …)` в подзапросе
 * либо `LATERAL`-соединение; и то и другое требует отдельного запроса на связь и заметно
 * усложняет гидрацию сущностей в TypeORM.
 *
 * Здесь выбран более простой путь: связанные записи приходят целиком, а срез делается уже
 * над готовым деревом сущностей. Результат при этом верный — сортировка вложенного
 * `$orderby` применена в SQL, то есть порядок к моменту среза уже правильный.
 *
 * ЧЕМ ЗА ЭТО ПЛАТИМ: из базы поднимаются все связанные строки, а не только нужная страница.
 * Для связи с десятками записей на родителя это незаметно; для связи с тысячами —
 * ощутимо, и там вложенный `$top` лучше не использовать. Перенос среза в SQL —
 * см. `docs/roadmap.md`, задача R-16.
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
 * @returns те же сущности, для удобства сцепления вызовов.
 *
 * @example
 * // $expand=books($top=2;$skip=1) — у каждого автора останутся книги с 2-й по 3-ю
 * applyNestedPagination(authors, odataQuery.includes);
 */
export function applyNestedPagination<T extends ObjectLiteral>(
  entities: T[],
  includes: readonly TypeOrmVisitor[]
): T[] {
  trimLevel(entities, includes);

  return entities;
}

/**
 * Обходит один уровень сущностей и применяет срез к каждой связи этого уровня.
 *
 * Рекурсия идёт по дереву include, а не по сущностям: связей всегда на порядки меньше,
 * чем строк, поэтому цикл по связям снаружи, а по сущностям — внутри.
 */
function trimLevel(entities: readonly ObjectLiteral[], includes: readonly TypeOrmVisitor[]): void {
  if (!includes.length) {
    return;
  }

  for (const entity of entities) {
    // Гидрация TypeORM оставляет null у связи «многие-к-одному» без записи.
    if (!entity) {
      continue;
    }

    for (const include of includes) {
      trimRelation(entity, include);
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
function trimRelation(entity: ObjectLiteral, include: TypeOrmVisitor): void {
  const value = entity[include.navigationProperty];

  if (Array.isArray(value)) {
    const trimmed = sliceRelation(value, include);

    entity[include.navigationProperty] = trimmed;

    trimLevel(trimmed, include.includes);

    return;
  }

  if (value && typeof value === 'object') {
    trimLevel([value as ObjectLiteral], include.includes);
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

  const start = hasSkip ? include.skip : 0;
  const end = hasLimit ? start + include.limit : undefined;

  return items.slice(start, end);
}
