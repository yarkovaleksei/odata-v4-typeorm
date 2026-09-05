/**
 * @file Превращает дерево `TypeOrmVisitor.includes` (результат разбора `$expand`) в цепочку вызовов
 * `leftJoin` / `leftJoinAndSelect`, `addSelect`, `addOrderBy` на переданном `SelectQueryBuilder`.
 *
 * Для вложенных expand выполняется рекурсия: ищутся метаданные связи по `propertyPath`, затем
 * `processIncludes` вызывается для целевой сущности с алиасом дочернего посетителя.
 *
 * Почему всегда LEFT, а не INNER: `$expand` в OData не должен отсеивать сущности, у которых
 * связанной записи нет, — иначе `$expand` начал бы работать как скрытый фильтр.
 *
 * ЧТО НЕ ПОДДЕРЖИВАЕТСЯ. Вложенные `$top` / `$skip` внутри `$expand` (`$expand=posts($top=2)`)
 * посетитель разбирает и кладёт в `item.limit` / `item.skip`, но здесь эти поля не читаются —
 * ограничение молча игнорируется, возвращаются все связанные записи. Честная реализация требует
 * оконных функций или отдельного запроса на связь. См. `docs/roadmap.md`, задача R-16.
 */
import type { EntityMetadata, ObjectLiteral, SelectQueryBuilder } from 'typeorm';

import type { TypeOrmVisitor } from '../../TypeOrmVisitor';
import { mapToObject } from '../mapToObject';

/**
 * Обрабатывает OData-параметр `$expand` (внутреннее представление `includes`),
 * добавляя в queryBuilder необходимые `LEFT JOIN` и выборку полей.
 *
 * @param queryBuilder - текущий построитель запросов TypeORM
 * @param odataQuery - объект с разобранными OData-параметрами, содержит свойство `includes`.
 *   При рекурсии сюда передаётся синтетический `{ includes: item.includes }`, а не полный посетитель.
 * @param alias - алиас родительской сущности (`'User'` на верхнем уровне, алиас include — глубже).
 *   Пустая строка означает «путь связи указывать без префикса».
 * @param parent_metadata - метаданные родительской сущности; нужны только для рекурсии,
 *   чтобы по имени связи найти целевую сущность и её метаданные.
 * @returns тот же queryBuilder (методы TypeORM возвращают this, но переприсваивание сохранено явно)
 */
export const processIncludes = <T extends ObjectLiteral = ObjectLiteral>(
  queryBuilder: SelectQueryBuilder<T>,
  odataQuery: Partial<TypeOrmVisitor>,
  alias: string,
  parent_metadata: EntityMetadata
): SelectQueryBuilder<T> => {
  // Нет вложенных связей — возвращаем queryBuilder как есть.
  if (odataQuery.includes && odataQuery.includes.length > 0) {
    // Каждый элемент includes — отдельный сегмент $expand со своим алиасом и своими опциями.
    odataQuery.includes.forEach((item) => {
      // Тип JOIN определяется по select дочернего посетителя:
      // - '*' (значение по умолчанию, вложенный $select не задан) → leftJoinAndSelect,
      //   TypeORM сам добавит в выборку все колонки связи;
      // - иначе → leftJoin + ручной addSelect только нужных колонок.
      // Отдельный случай — «виртуальный» include из фильтра по пути `связь/поле`: у него select === '',
      // он попадает в ветку leftJoin, addSelect получает пустой список и связь джойнится без выборки.
      const join = item.select === '*' ? 'leftJoinAndSelect' : 'leftJoin';

      if (join === 'leftJoin') {
        // filter(x => x !== '') нужен именно для случая select === '' (JOIN ради условия).
        //
        // Колонки с `@Column({ select: false })` сюда не доходят: обращение к ним отсекается
        // раньше, в `assertNoHiddenFields`, вместе с обращениями из `$filter` и `$orderby`.
        // Ветка `leftJoinAndSelect` (когда вложенный $select не задан) скрывает их сама —
        // это штатное поведение TypeORM.
        queryBuilder.addSelect(
          item.select
            .split(',')
            .map((x: string) => x.trim())
            .filter((x: string) => x !== '')
        );
      }

      // Аргументы JOIN:
      // 1. путь связи — 'родительскийАлиас.связь' либо просто 'связь', если алиаса нет;
      // 2. алиас присоединяемой таблицы (item.alias, вида 'posts8');
      // 3. дополнительное условие ON. У пустого $filter связи это '1 = 1' — нейтральное условие,
      //    TypeORM добавит его к ON поверх собственного условия связи по внешнему ключу;
      // 4. параметры условия из Map посетителя.
      //
      // 'typeorm_query' — плейсхолдер, который базовый Visitor из odata-v4-sql подставляет
      // как имя таблицы вложенного запроса. Здесь он меняется на реальное имя связи.
      queryBuilder = queryBuilder[join](
        (alias ? `${alias}.` : '') + item.navigationProperty,
        item.alias,
        item.where.replace(/typeorm_query/g, item.navigationProperty),
        mapToObject(item.parameters)
      );

      // '1' — orderby по умолчанию у базового посетителя, трактуется как «сортировка не задана».
      if (item.orderby && item.orderby != '1') {
        // Строка вида 'posts8.name ASC, posts8.created DESC'.
        const orders: string[] = item.orderby
          .split(',')
          .map((i: string) => i.trim().replace(/typeorm_query/g, item.navigationProperty));

        orders.forEach((orderItem) => {
          const [field, order] = orderItem.split(' ');
          // addOrderBy, а не orderBy: сортировки корня и всех связей накапливаются в одном ORDER BY.
          queryBuilder = queryBuilder.addOrderBy(field, order as 'ASC' | 'DESC');
        });
      }

      // Рекурсия для вложенных $expand: `$expand=posts($expand=comments)`.
      if (item.includes && item.includes.length > 0) {
        // Чтобы уйти на уровень глубже, нужны метаданные целевой сущности связи,
        // а найти связь можно только по её propertyPath в метаданных родителя.
        const target = parent_metadata.relations.find(
          (x) => x.propertyPath === item.navigationProperty
        );

        // Если связи с таким именем нет — молча пропускаем ветку. Ошибку про неизвестную связь
        // всё равно поднимет сам TypeORM на вызове leftJoin выше по стеку.
        if (target) {
          const relation_metadata = queryBuilder.connection.getMetadata(target.type);
          // На следующем уровне родительским алиасом становится алиас текущего include.
          processIncludes(queryBuilder, { includes: item.includes }, item.alias, relation_metadata);
        }
      }
    });
  }

  return queryBuilder;
};
