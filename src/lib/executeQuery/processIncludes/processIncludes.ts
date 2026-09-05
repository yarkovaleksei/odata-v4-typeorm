/**
 * Превращает дерево `TypeOrmVisitor.includes` (результат разбора `$expand`) в цепочку вызовов
 * `leftJoin` / `leftJoinAndSelect`, `addSelect`, `addOrderBy` на переданном `SelectQueryBuilder`.
 *
 * Для вложенных expand выполняется рекурсия: ищется метаданные связи по `propertyPath`, затем
 * `processIncludes` вызывается для целевой сущности с алиасом дочернего посетителя.
 */
import type { EntityMetadata, ObjectLiteral, SelectQueryBuilder } from 'typeorm';

import type { TypeOrmVisitor } from '../../TypeOrmVisitor';
import { mapToObject } from '../mapToObject';

/**
 * Обрабатывает OData-параметр `$expand` (внутреннее представление `includes`),
 * добавляя в queryBuilder необходимые `LEFT JOIN` и выборку полей.
 *
 * @param queryBuilder - текущий построитель запросов TypeORM
 * @param odataQuery - объект с разобранными OData-параметрами, содержит свойство `includes`
 * @param alias - алиас родительской сущности (например, 'user')
 * @param parent_metadata - метаданные родительской сущности (для поиска связей)
 * @returns модифицированный queryBuilder
 */
export const processIncludes = <T extends ObjectLiteral = ObjectLiteral>(
  queryBuilder: SelectQueryBuilder<T>,
  odataQuery: Partial<TypeOrmVisitor>,
  alias: string,
  parent_metadata: EntityMetadata
): SelectQueryBuilder<T> => {
  // Если нет вложенных связей – выходим
  if (odataQuery.includes && odataQuery.includes.length > 0) {
    // Перебираем каждую связь (каждый элемент массива includes)
    odataQuery.includes.forEach((item) => {
      // Определяем тип JOIN:
      // - если запрошены все поля (select === '*') → используем leftJoinAndSelect
      // - иначе используем leftJoin (поля потом добавим отдельно через addSelect)
      const join = item.select === '*' ? 'leftJoinAndSelect' : 'leftJoin';

      if (join === 'leftJoin') {
        // Добавляем выборку только указанных полей (а не всей сущности)
        // TODO: удалить колонки, у которых isSelect: false (возможно, их не нужно включать)
        queryBuilder.addSelect(
          item.select
            .split(',')
            .map((x: string) => x.trim())
            .filter((x: string) => x !== '')
        );
      }

      // Выполняем JOIN:
      // - путь: если есть alias родителя, то 'alias.связь', иначе просто 'связь'
      // - алиас для присоединяемой таблицы (item.alias)
      // - условие WHERE (заменяем плейсхолдер typeorm_query на имя свойства навигации)
      // - параметры (преобразуем Map в объект)
      queryBuilder = queryBuilder[join](
        (alias ? `${alias}.` : '') + item.navigationProperty,
        item.alias,
        item.where.replace(/typeorm_query/g, item.navigationProperty),
        mapToObject(item.parameters)
      );

      // Если задана сортировка и она не равна '1' (условное обозначение "без сортировки")
      if (item.orderby && item.orderby != '1') {
        // Разбираем строку сортировки (например, "name asc, created desc")
        const orders: string[] = item.orderby
          .split(',')
          .map((i: string) => i.trim().replace(/typeorm_query/g, item.navigationProperty));

        orders.forEach((orderItem) => {
          const [field, order] = orderItem.split(' ');
          // Добавляем сортировку в запрос
          queryBuilder = queryBuilder.addOrderBy(field, order as 'ASC' | 'DESC');
        });
      }

      // Рекурсивно обрабатываем вложенные связи (под-подгрузка)
      if (item.includes && item.includes.length > 0) {
        // Ищем метаданные связи по имени свойства навигации
        const target = parent_metadata.relations.find(
          (x) => x.propertyPath === item.navigationProperty
        );

        if (target) {
          // Получаем метаданные целевой сущности
          const relation_metadata = queryBuilder.connection.getMetadata(target.type);
          // Рекурсивный вызов для вложенных includes
          processIncludes(queryBuilder, { includes: item.includes }, item.alias, relation_metadata);
        }
      }
    });
  }

  return queryBuilder;
};
