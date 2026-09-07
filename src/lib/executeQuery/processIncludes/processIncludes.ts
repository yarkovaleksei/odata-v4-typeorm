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
 * ВЛОЖЕННАЯ ПАГИНАЦИЯ. `$expand=posts($top=2;$skip=1)` переносится в SQL: к `ON` дописывается
 * условие с оконной функцией, оставляющее у каждого родителя только запрошенную страницу
 * (см. `buildNestedPageCondition`). Там, где это невозможно — MySQL, незнакомый драйвер,
 * вложенный `$orderby` по соседней связи, — условие не строится, и срез делает
 * `applyNestedPagination` уже над деревом сущностей. Какие связи обработаны в SQL,
 * `processIncludes` складывает в переданный `paginated`: резать их второй раз в памяти нельзя.
 */
import type { DataSource, EntityMetadata, ObjectLiteral, SelectQueryBuilder } from 'typeorm';

import { type TypeOrmVisitor, VISITOR_DEFAULTS } from '../../TypeOrmVisitor';
import { applyOrderBy } from '../applyOrderBy';
import { mapToObject } from '../mapToObject';
import { buildNestedPageCondition } from '../nestedPageCondition';

/**
 * Настройки переноса вложенной пагинации в SQL.
 *
 * @property paginated - сюда складываются include, страницу которых уже вырезал SQL.
 *   Множество заполняется по ходу обхода и читается затем `applyNestedPagination`.
 * @property enabled - разрешён ли перенос вообще (опция `nestedPaginationInSql`).
 */
export interface NestedPaginationOptions {
  paginated: Set<TypeOrmVisitor>;
  enabled: boolean;
}

/**
 * Дописывает к условию JOIN условие вложенной пагинации, если её удалось перенести в SQL.
 *
 * @returns условие для `ON` и параметры к нему — с уже добавленной страницей либо без неё.
 */
function withNestedPage(
  connection: DataSource,
  parentMetadata: EntityMetadata,
  parentAlias: string,
  item: TypeOrmVisitor,
  fragments: { where: string; orderby: string },
  parameters: Record<string, unknown>,
  nested: NestedPaginationOptions | undefined
): { condition: string; parameters: Record<string, unknown> } {
  const plain = { condition: fragments.where, parameters };

  if (!nested?.enabled) {
    return plain;
  }

  const relation = parentMetadata.relations.find(
    (candidate) => candidate.propertyPath === item.navigationProperty
  );

  if (!relation) {
    return plain;
  }

  const page = buildNestedPageCondition(connection, relation, parentAlias, item, fragments);

  if (!page) {
    return plain;
  }

  nested.paginated.add(item);

  return {
    // Условие связи TypeORM допишет само; здесь соединяются только условия из OData.
    condition: `(${fragments.where}) AND ${page.condition}`,
    parameters: { ...parameters, ...page.parameters },
  };
}

/**
 * Обрабатывает OData-параметр `$expand` (внутреннее представление `includes`),
 * добавляя в queryBuilder необходимые `LEFT JOIN` и выборку полей.
 *
 * @param queryBuilder - текущий построитель запросов TypeORM
 * @param odataQuery - объект с разобранными OData-параметрами, содержит свойство `includes`.
 *   При рекурсии сюда передаётся синтетический `{ includes: item.includes }`, а не полный посетитель.
 * @param alias - алиас родительской сущности (`'User'` на верхнем уровне, алиас include — глубже).
 *   Пустая строка означает «путь связи указывать без префикса».
 * @param parent_metadata - метаданные родительской сущности; нужны для рекурсии (по имени связи
 *   найти целевую сущность) и для переноса вложенной пагинации в SQL.
 * @param nested - куда записывать связи, страницу которых уже вырезал SQL, и разрешён ли перенос.
 *   Не передан — вложенные `$top` / `$skip` в SQL не переносятся вовсе.
 * @returns тот же queryBuilder (методы TypeORM возвращают this, но переприсваивание сохранено явно)
 */
export const processIncludes = <T extends ObjectLiteral = ObjectLiteral>(
  queryBuilder: SelectQueryBuilder<T>,
  odataQuery: Partial<TypeOrmVisitor>,
  alias: string,
  parent_metadata: EntityMetadata,
  nested?: NestedPaginationOptions
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
      const join = item.select === VISITOR_DEFAULTS.select ? 'leftJoinAndSelect' : 'leftJoin';

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

      // 'typeorm_query' — плейсхолдер имени таблицы вложенного запроса, который подставлял
      // базовый Visitor из odata-v4-sql. Собственный TypeOrmVisitor его больше не порождает:
      // алиас связи он знает сам и пишет сразу (`Author_books.title`). Замена оставлена ради
      // вызывающего кода, который строит посетителя вручную и мог на неё опираться, —
      // на фрагментах из `createQuery` она не находит ничего.
      // Раскрывается один раз: те же фрагменты уходят и в ON, и в подзапрос пагинации.
      const fragments = {
        where: item.where.replace(/typeorm_query/g, item.navigationProperty),
        orderby: (item.orderby ?? '').replace(/typeorm_query/g, item.navigationProperty),
      };

      const on = withNestedPage(
        queryBuilder.connection,
        parent_metadata,
        alias,
        item,
        fragments,
        mapToObject(item.parameters),
        nested
      );

      // Аргументы JOIN:
      // 1. путь связи — 'родительскийАлиас.связь' либо просто 'связь', если алиаса нет;
      // 2. алиас присоединяемой таблицы (item.alias, вида 'posts8');
      // 3. дополнительное условие ON. У пустого $filter связи это '1 = 1' — нейтральное условие,
      //    TypeORM добавит его к ON поверх собственного условия связи по внешнему ключу;
      // 4. параметры условия: из Map посетителя плюс границы страницы, если она вырезается в SQL.
      queryBuilder = queryBuilder[join](
        (alias ? `${alias}.` : '') + item.navigationProperty,
        item.alias,
        on.condition,
        on.parameters
      );

      // Сортировка связи дописывается после корневой и упорядочивает записи внутри
      // каждого родителя. Строка вида 'Author_books.name ASC, Author_books.created DESC'.
      queryBuilder = applyOrderBy(queryBuilder, fragments.orderby);

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
          processIncludes(
            queryBuilder,
            { includes: item.includes },
            item.alias,
            relation_metadata,
            nested
          );
        }
      }
    });
  }

  return queryBuilder;
};
