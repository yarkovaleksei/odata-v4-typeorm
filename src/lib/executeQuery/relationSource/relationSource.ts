/**
 * @file Источник строк для подзапроса по связи: `FROM` и условие соединения с родителем.
 *
 * ЗАЧЕМ. Два места строят один и тот же подзапрос: поиск по полю связи
 * (`searchFields: ['author/name']`) и лямбда-операторы `$filter=books/any(b: …)`. Оба
 * разворачиваются в `EXISTS (SELECT 1 FROM … WHERE <связь с родителем> AND <условие>)`,
 * и разница между ними — только в условии, которое подставляется последним.
 *
 * ПОЧЕМУ EXISTS, А НЕ JOIN. Соединение с коллекцией размножает корневые строки: у автора
 * с тремя книгами `$top=10` вернул бы не десять авторов. `EXISTS` не меняет число строк
 * и потому не ломает пагинацию.
 *
 * ПОЧЕМУ ПЛОСКИЙ `FROM`, А НЕ ВЛОЖЕННЫЕ EXISTS. Для пути `books/reviews` можно построить
 * либо `EXISTS(book … EXISTS(review …))`, либо один `EXISTS` с двумя таблицами в `FROM`
 * и условиями в `WHERE`. Второе короче, читается линейно и одинаково выполняется
 * планировщиком: соединение остаётся соединением независимо от того, записано оно
 * вложенностью или списком.
 */
import type { DataSource, EntityMetadata } from 'typeorm';

import type { RelationResolver } from '../../types';

/** Метаданные связи. Тип выводится из `EntityMetadata`, а не берётся глубоким импортом. */
type RelationMetadata = EntityMetadata['relations'][number];

/** Готовый источник строк для подзапроса вместе с метаданными целевой сущности. */
export interface ResolvedRelation {
  /** Содержимое `FROM`: таблицы с алиасами, при «многих ко многим» — вместе с таблицей связей. */
  from: string;
  /** Условие, связывающее подзапрос с родителем и таблицы между собой. */
  where: string;
  /** Метаданные сущности, до которой довёл путь: по ним резолвятся поля внутри подзапроса. */
  metadata: EntityMetadata;
}

/** Имя таблицы с учётом схемы: `public.book` экранируется посегментно. */
function escapeTablePath(connection: DataSource, tablePath: string): string {
  return tablePath
    .split('.')
    .map((segment) => connection.driver.escape(segment))
    .join('.');
}

/**
 * Условие и таблицы для одного шага пути.
 *
 * Внешний ключ лежит либо в родительской таблице (`ManyToOne`, владеющая сторона `OneToOne`),
 * либо в дочерней (`OneToMany`, обратная сторона `OneToOne`), либо в отдельной таблице связей
 * (`ManyToMany`) — отсюда три ветки.
 *
 * @returns `undefined`, если метаданных не хватает: молча построить неверный SQL хуже,
 *   чем отказаться от подзапроса и сообщить об этом вызывающему коду.
 */
function step(
  connection: DataSource,
  relation: RelationMetadata,
  parentAlias: string,
  childAlias: string
): { tables: string[]; conditions: string[] } | undefined {
  const escape = (name: string) => connection.driver.escape(name);
  const target = relation.inverseEntityMetadata;
  const childTable = `${escapeTablePath(connection, target.tablePath)} ${escape(childAlias)}`;

  // Внешний ключ в родительской таблице.
  if (relation.joinColumns.length > 0 && !relation.isManyToMany) {
    const conditions: string[] = [];

    for (const column of relation.joinColumns) {
      if (!column.referencedColumn) {
        return undefined;
      }

      conditions.push(
        `${escape(childAlias)}.${escape(column.referencedColumn.databaseName)} = ` +
          `${escape(parentAlias)}.${escape(column.databaseName)}`
      );
    }

    return { tables: [childTable], conditions };
  }

  // Внешний ключ в дочерней таблице.
  if (relation.isOneToMany || relation.isOneToOneNotOwner) {
    const inverse = relation.inverseRelation;

    if (!inverse || inverse.joinColumns.length === 0) {
      return undefined;
    }

    const conditions: string[] = [];

    for (const column of inverse.joinColumns) {
      if (!column.referencedColumn) {
        return undefined;
      }

      conditions.push(
        `${escape(childAlias)}.${escape(column.databaseName)} = ` +
          `${escape(parentAlias)}.${escape(column.referencedColumn.databaseName)}`
      );
    }

    return { tables: [childTable], conditions };
  }

  if (relation.isManyToMany) {
    const owning = relation.isOwning ? relation : relation.inverseRelation;
    const junction = relation.junctionEntityMetadata;

    if (!owning || !junction) {
      return undefined;
    }

    // Колонки таблицы связей описаны относительно владеющей стороны; если запрос идёт
    // с обратной стороны, роли меняются местами.
    const parentSide = relation.isOwning ? owning.joinColumns : owning.inverseJoinColumns;
    const childSide = relation.isOwning ? owning.inverseJoinColumns : owning.joinColumns;

    if (parentSide.length === 0 || childSide.length === 0) {
      return undefined;
    }

    const junctionAlias = `${childAlias}__jt`;
    const conditions: string[] = [];

    for (const [columns, alias] of [
      [parentSide, parentAlias],
      [childSide, childAlias],
    ] as const) {
      for (const column of columns) {
        if (!column.referencedColumn) {
          return undefined;
        }

        conditions.push(
          `${escape(junctionAlias)}.${escape(column.databaseName)} = ` +
            `${escape(alias)}.${escape(column.referencedColumn.databaseName)}`
        );
      }
    }

    return {
      tables: [
        `${escapeTablePath(connection, junction.tablePath)} ${escape(junctionAlias)}`,
        childTable,
      ],
      conditions,
    };
  }

  return undefined;
}

/**
 * Строит источник строк для подзапроса по пути связей.
 *
 * @param connection - подключение: нужно для экранирования идентификаторов по правилам драйвера.
 * @param metadata - метаданные сущности, от которой отсчитывается путь.
 * @param navigation - путь связей: `['books']`, `['books', 'reviews']`.
 * @param parentAlias - SQL-алиас родительской таблицы во внешнем запросе.
 * @param childAlias - алиас, под которым в подзапросе будет доступна последняя связь пути.
 * @returns `FROM`, условие и метаданные целевой сущности; `undefined`, если путь не существует
 *   либо метаданных связи не хватает.
 *
 * @example
 * buildRelationSource(connection, authorMetadata, ['books'], 'Author', 'b');
 * // { from: '"book" "b"', where: '"b"."author_id" = "Author"."id"', metadata: … }
 */
export function buildRelationSource(
  connection: DataSource,
  metadata: EntityMetadata,
  navigation: readonly string[],
  parentAlias: string,
  childAlias: string
): ResolvedRelation | undefined {
  if (navigation.length === 0) {
    return undefined;
  }

  const tables: string[] = [];
  const conditions: string[] = [];

  let current = metadata;
  let alias = parentAlias;

  for (const [index, name] of navigation.entries()) {
    // Промежуточные звенья получают служебные алиасы; последнее — то имя, которое ждёт
    // вызывающий код (переменная лямбды либо алиас поля поиска).
    const nextAlias = index === navigation.length - 1 ? childAlias : `${childAlias}__n${index}`;
    const relation = current.relations.find((candidate) => candidate.propertyPath === name);

    if (!relation) {
      return undefined;
    }

    const joined = step(connection, relation, alias, nextAlias);

    if (!joined) {
      return undefined;
    }

    tables.push(...joined.tables);
    conditions.push(...joined.conditions);
    current = relation.inverseEntityMetadata;
    alias = nextAlias;
  }

  return { from: tables.join(', '), where: conditions.join(' AND '), metadata: current };
}

/**
 * Готовая функция разрешения связей для компилятора OData.
 *
 * Компилятор работает со строками SQL и метаданных не знает — имя таблицы и колонки внешнего
 * ключа называет слой выполнения. Резолвер получается самовоспроизводящимся: вместе
 * с подзапросом он отдаёт резолвер уже от целевой сущности, и вложенная лямбда
 * (`books/any(b: b/reviews/any(r: …))`) считает связи от книги, а не от автора.
 *
 * @param connection - подключение: экранирование идентификаторов и метаданные сущностей.
 * @param metadata - сущность, от которой отсчитываются пути.
 *
 * @example
 * createQuery(odataString, { alias, resolveRelation: createRelationResolver(connection, metadata) });
 */
export function createRelationResolver(
  connection: DataSource,
  metadata: EntityMetadata
): RelationResolver {
  return (navigation, parentAlias, childAlias) => {
    const resolved = buildRelationSource(connection, metadata, navigation, parentAlias, childAlias);

    if (!resolved) {
      return undefined;
    }

    const escape = (name: string) => connection.driver.escape(name);

    return {
      from: resolved.from,
      where: resolved.where,
      resolveRelation: createRelationResolver(connection, resolved.metadata),
      column: (property) => {
        const column = resolved.metadata.columns.find(
          (candidate) => candidate.propertyPath === property
        );

        // Неизвестное имя уходит в запрос как есть: про несуществующую колонку понятнее
        // и точнее сообщит сама СУБД — так же ведут себя и остальные пути библиотеки.
        return `${escape(childAlias)}.${escape(column?.databaseName ?? property)}`;
      },
    };
  };
}
