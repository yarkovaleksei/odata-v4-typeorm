/**
 * @file Вложенная пагинация `$expand=books($top=2;$skip=1)` средствами SQL.
 *
 * ЗАДАЧА. Связи загружаются одним запросом через `LEFT JOIN`, и `LIMIT` в нём действует на весь
 * плоский результат, а не на группу строк одного родителя. Ограничить коллекцию каждого родителя
 * независимо умеет оконная функция: пронумеровать связанные строки внутри каждого родителя
 * и оставить нужный отрезок нумерации.
 *
 * ГДЕ ЭТО ЖИВЁТ В ЗАПРОСЕ. Условие дописывается к `ON` того самого `LEFT JOIN`, который TypeORM
 * и так строит для связи. Это принципиально: подзапрос в `FROM` сломал бы гидрацию — TypeORM
 * собирает сущности по алиасам колонок реального join'а, — а отдельный запрос на связь потребовал
 * бы собирать дерево сущностей руками. Условие в `ON` меняет только набор присоединяемых строк,
 * гидрация остаётся штатной.
 *
 * ```sql
 * LEFT JOIN "book" "Author_books"
 *   ON "Author_books"."author_id" = "Author"."id"
 *   AND "Author_books"."id" IN (
 *     SELECT "Author_books__page"."__k0" FROM (
 *       SELECT "Author_books"."id" AS "__k0",
 *              ROW_NUMBER() OVER (PARTITION BY "Author_books"."author_id"
 *                                 ORDER BY "Author_books"."id" ASC) AS "__rn"
 *       FROM "book" "Author_books"
 *     ) "Author_books__page"
 *     WHERE "Author_books__page"."__rn" > :Author_books__skip
 *       AND "Author_books__page"."__rn" <= :Author_books__end
 *   )
 * ```
 *
 * ПОЧЕМУ ВНУТРИ ПОДЗАПРОСА ТОТ ЖЕ АЛИАС — И ЭТО ОБЯЗАТЕЛЬНО. Посетитель компилирует вложенные
 * `$filter` и `$orderby` в фрагменты вида `Author_books.title`, где `title` — имя СВОЙСТВА,
 * а не колонки. В имя колонки его превращает сам TypeORM: перед выполнением он проходит по
 * всему тексту запроса и заменяет `алиас.свойство` на `"алиас"."колонка"` для каждого
 * известного ему алиаса. Замена текстовая, поэтому достаёт и до подзапроса — но только если
 * таблица в нём названа тем же алиасом. Назвать её иначе значит получить в подзапросе
 * `title` там, где в базе `registered_at`.
 *
 * Отсюда же следует, что фрагменты вставляются как есть, без разбора и переписывания строк,
 * на котором эта библиотека уже обжигалась (дефект A-02). Внутренний алиас перекрывает внешний
 * только в пределах подзапроса; снаружи имя снова означает присоединённую таблицу.
 *
 * КОГДА ПАГИНАЦИЯ НЕ ПЕРЕНОСИТСЯ В SQL — возвращается `undefined`, и срез делает
 * `applyNestedPagination` над деревом сущностей:
 *
 * - СУБД вычисляет окно неверно или про неё ничего не известно — MySQL и незнакомый
 *   драйвер, см. `supportsNestedPagePushdown`; либо перенос отключён опцией;
 * - связь не коллекция: у `ManyToOne` и `OneToOne` ограничивать нечего;
 * - вложенный `$filter` или `$orderby` ссылается на другую связь (`$expand=books($orderby=category/name)`):
 *   её алиас в подзапросе не существует, а тащить туда весь граф JOIN'ов — отдельная задача
 *   с сомнительной отдачей;
 * - в метаданных связи нет того, из чего строится условие (нет обратной связи, нет ссылки
 *   на колонку родителя). Такого быть не должно, но молча выдавать неверный SQL хуже,
 *   чем вернуться к проверенному срезу в памяти.
 */
import type { DataSource, EntityMetadata } from 'typeorm';

import { normalizeDialect, supportsNestedPagePushdown } from '../../dialect';
import type { TypeOrmVisitor } from '../../TypeOrmVisitor';

/** Метаданные связи. Берутся из `EntityMetadata`, а не глубоким импортом: см. `ColumnMetadata`. */
type RelationMetadata = EntityMetadata['relations'][number];

/** Метаданные колонки соединения (`joinColumns` / `inverseJoinColumns`). */
type JoinColumnMetadata = RelationMetadata['joinColumns'][number];

/** Готовое условие для `ON` вместе с параметрами границ страницы. */
export interface NestedPageCondition {
  /** SQL-условие; подставляется в `ON` через `AND`. */
  condition: string;
  /** Значения границ: `{ Author_books__skip: 1, Author_books__end: 3 }`. */
  parameters: Record<string, number>;
}

/**
 * Часть подзапроса, зависящая от вида связи.
 *
 * @property from - содержимое `FROM` со всеми нужными соединениями.
 * @property partitionColumns - выражения, по которым нумеруются строки (ключ родителя).
 * @property parentColumns - те же значения со стороны родителя, позиция в позицию;
 *   нужны только корреляции в форме `EXISTS`.
 * @property keyColumns - первичный ключ связанной строки внутри подзапроса.
 * @property outerKeyColumns - он же снаружи, у присоединённой таблицы.
 * @property keyProperties - тот же ключ, но именами свойств: в таком виде на него ссылается
 *   вложенный `$orderby`, и только так его там можно узнать.
 */
interface WindowSource {
  from: string;
  partitionColumns: string[];
  parentColumns: string[];
  keyColumns: string[];
  outerKeyColumns: string[];
  keyProperties: string[];
}

/**
 * Квалификатор перед точкой: `alias.field`, а также экранированные формы всех трёх диалектов.
 *
 * Посетитель пишет алиас без кавычек, но фрагмент мог прийти и от вызывающего кода,
 * поэтому распознаются обе записи. Числа вида `1.5` под шаблон не попадают: идентификатор
 * не может начинаться с цифры.
 */
const QUALIFIER = /(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_]*))\s*\./g;

/**
 * Ссылается ли фрагмент SQL только на разрешённый алиас.
 *
 * Литералов в скомпилированных фрагментах нет — посетитель выносит их в параметры `:pN`, —
 * поэтому имя перед точкой всегда является алиасом таблицы.
 */
function referencesOnly(fragment: string, alias: string): boolean {
  for (const match of fragment.matchAll(QUALIFIER)) {
    const qualifier = match[1] ?? match[2] ?? match[3] ?? match[4];

    if (qualifier !== alias) {
      return false;
    }
  }

  return true;
}

/**
 * Имя таблицы с учётом схемы: `public.book` экранируется посегментно.
 *
 * Экранировать `tablePath` целиком нельзя — получилось бы одно имя `"public.book"`.
 */
function escapeTablePath(connection: DataSource, tablePath: string): string {
  return tablePath
    .split('.')
    .map((segment) => connection.driver.escape(segment))
    .join('.');
}

/** Строит источник строк для связи «один ко многим»: внешний ключ лежит в самой связанной таблице. */
function oneToManySource(
  connection: DataSource,
  relation: RelationMetadata,
  parentAlias: string,
  childAlias: string
): WindowSource | undefined {
  const escape = (name: string) => connection.driver.escape(name);
  const inverse = relation.inverseRelation;

  // У `OneToMany` обратная сторона обязана существовать — связь объявляется парой.
  if (!inverse || inverse.joinColumns.length === 0) {
    return undefined;
  }

  const target = relation.inverseEntityMetadata;
  const parentColumns = referencedParentColumns(connection, inverse.joinColumns, parentAlias);

  if (!parentColumns) {
    return undefined;
  }

  return {
    from: `${escapeTablePath(connection, target.tablePath)} ${escape(childAlias)}`,
    partitionColumns: inverse.joinColumns.map(
      (column) => `${escape(childAlias)}.${escape(column.databaseName)}`
    ),
    parentColumns,
    keyColumns: target.primaryColumns.map(
      (column) => `${escape(childAlias)}.${escape(column.databaseName)}`
    ),
    outerKeyColumns: target.primaryColumns.map(
      (column) => `${escape(childAlias)}.${escape(column.databaseName)}`
    ),
    keyProperties: target.primaryColumns.map((column) => `${childAlias}.${column.propertyPath}`),
  };
}

/**
 * Строит источник строк для связи «многие ко многим»: нумеровать нужно строки таблицы связей.
 *
 * Владеющая сторона объявлена ровно одна, и колонки соединения описаны относительно неё:
 * `joinColumns` смотрят на владельца, `inverseJoinColumns` — на другую сущность. Если запрос
 * идёт с обратной стороны (`Tag.books`), роли меняются местами.
 */
function manyToManySource(
  connection: DataSource,
  relation: RelationMetadata,
  parentAlias: string,
  childAlias: string
): WindowSource | undefined {
  const escape = (name: string) => connection.driver.escape(name);
  const owning = relation.isOwning ? relation : relation.inverseRelation;
  const junction = relation.junctionEntityMetadata;

  if (!owning || !junction) {
    return undefined;
  }

  const parentSide = relation.isOwning ? owning.joinColumns : owning.inverseJoinColumns;
  const childSide = relation.isOwning ? owning.inverseJoinColumns : owning.joinColumns;

  if (parentSide.length === 0 || childSide.length === 0) {
    return undefined;
  }

  const parentColumns = referencedParentColumns(connection, parentSide, parentAlias);

  if (!parentColumns) {
    return undefined;
  }

  const junctionAlias = `${childAlias}__jt`;
  const target = relation.inverseEntityMetadata;
  const junctionOn: string[] = [];

  for (const column of childSide) {
    const referenced = column.referencedColumn;

    if (!referenced) {
      return undefined;
    }

    junctionOn.push(
      `${escape(childAlias)}.${escape(referenced.databaseName)} = ` +
        `${escape(junctionAlias)}.${escape(column.databaseName)}`
    );
  }

  return {
    from:
      `${escapeTablePath(connection, junction.tablePath)} ${escape(junctionAlias)} ` +
      `INNER JOIN ${escapeTablePath(connection, target.tablePath)} ${escape(childAlias)} ` +
      `ON ${junctionOn.join(' AND ')}`,
    partitionColumns: parentSide.map(
      (column) => `${escape(junctionAlias)}.${escape(column.databaseName)}`
    ),
    parentColumns,
    keyColumns: target.primaryColumns.map(
      (column) => `${escape(childAlias)}.${escape(column.databaseName)}`
    ),
    outerKeyColumns: target.primaryColumns.map(
      (column) => `${escape(childAlias)}.${escape(column.databaseName)}`
    ),
    keyProperties: target.primaryColumns.map((column) => `${childAlias}.${column.propertyPath}`),
  };
}

/**
 * Колонки родителя, на которые ссылаются колонки соединения.
 *
 * @returns `undefined`, если хотя бы у одной колонки нет ссылки: строить условие по неполным
 *   метаданным нельзя.
 */
function referencedParentColumns(
  connection: DataSource,
  joinColumns: readonly JoinColumnMetadata[],
  parentAlias: string
): string[] | undefined {
  const escape = (name: string) => connection.driver.escape(name);
  const columns: string[] = [];

  for (const column of joinColumns) {
    const referenced = column.referencedColumn;

    if (!referenced) {
      return undefined;
    }

    columns.push(`${escape(parentAlias)}.${escape(referenced.databaseName)}`);
  }

  return columns;
}

/**
 * Строит условие `ON`, оставляющее у каждого родителя только запрошенную страницу связанных строк.
 *
 * @param connection - подключение: нужно для экранирования идентификаторов по правилам драйвера.
 * @param relation - метаданные связи, к которой относится `$expand`.
 * @param parentAlias - SQL-алиас родительской таблицы.
 * @param include - дочерний посетитель; нужны только границы страницы и алиас связи.
 * @param fragments - те же `where` и `orderby`, но уже с раскрытым плейсхолдером `typeorm_query`,
 *   как их подставляет `processIncludes`.
 * @returns условие с параметрами либо `undefined`, если перенос в SQL невозможен —
 *   тогда срез должен сделать `applyNestedPagination`.
 *
 * @example
 * const page = buildNestedPageCondition(connection, relation, 'Author', include, fragments);
 *
 * if (page) {
 *   queryBuilder.leftJoinAndSelect('Author.books', 'Author_books', page.condition, page.parameters);
 * }
 */
export function buildNestedPageCondition(
  connection: DataSource,
  relation: RelationMetadata,
  parentAlias: string,
  include: Pick<TypeOrmVisitor, 'alias' | 'limit' | 'skip'>,
  fragments: { where: string; orderby: string }
): NestedPageCondition | undefined {
  const hasSkip = typeof include.skip === 'number' && include.skip > 0;
  const hasLimit = typeof include.limit === 'number';

  // Ни `$top`, ни ненулевого `$skip` — ограничивать нечего.
  if (!hasSkip && !hasLimit) {
    return undefined;
  }

  // Пагинация имеет смысл только для коллекции: `ManyToOne` и `OneToOne` дают одну запись.
  if (!relation.isOneToMany && !relation.isManyToMany) {
    return undefined;
  }

  // СУБД, которая считает окно после наложения внешнего условия, вернула бы неверную
  // страницу молча. Подробности и результаты прогона — в `supportsNestedPagePushdown`.
  if (!supportsNestedPagePushdown(normalizeDialect(connection.options.type))) {
    return undefined;
  }

  // Без алиаса родителя не на что сослаться из подзапроса.
  if (!parentAlias) {
    return undefined;
  }

  const childAlias = include.alias;
  const escape = (name: string) => connection.driver.escape(name);

  // Вложенный `$filter` и `$orderby` попадут внутрь подзапроса как есть, поэтому обязаны
  // ссылаться только на саму связь — алиасов соседних JOIN'ов там не существует.
  const where = fragments.where === '1 = 1' ? '' : fragments.where;
  const orderby = fragments.orderby === '1' ? '' : fragments.orderby;

  if (!referencesOnly(where, childAlias) || !referencesOnly(orderby, childAlias)) {
    return undefined;
  }

  const source = relation.isOneToMany
    ? oneToManySource(connection, relation, parentAlias, childAlias)
    : manyToManySource(connection, relation, parentAlias, childAlias);

  if (!source || source.keyColumns.length === 0 || source.partitionColumns.length === 0) {
    return undefined;
  }

  const pageAlias = `${childAlias}__page`;
  const rowNumber = `${escape(pageAlias)}.${escape('__rn')}`;

  // Первичный ключ дописывается к сортировке: без него порядок строк с одинаковым значением
  // ключа сортировки не определён, и соседние страницы могли бы пересекаться или терять записи.
  // Колонки, уже упомянутые во вложенном `$orderby`, повторно не добавляются — сверка идёт
  // по имени свойства, потому что именно в таком виде их пишет посетитель.
  const tieBreaker = source.keyColumns
    .filter((_, index) => !orderby.includes(source.keyProperties[index] as string))
    .map((column) => `${column} ASC`);

  const windowOrder = [orderby, ...tieBreaker].filter((part) => part !== '').join(', ');

  // Форма `IN` предпочтительнее `EXISTS`: подзапрос не коррелирован, и СУБД вычисляет его
  // один раз на весь запрос, а не на каждую строку соединения. Она годится, когда строка
  // однозначно определяет своего родителя (внешний ключ в самой таблице) и ключ односоставный.
  const useIn = relation.isOneToMany && source.keyColumns.length === 1;

  const selected = [
    ...(useIn
      ? []
      : source.partitionColumns.map((column, i) => `${column} AS ${escape(`__p${i}`)}`)),
    ...source.keyColumns.map((column, i) => `${column} AS ${escape(`__k${i}`)}`),
    `ROW_NUMBER() OVER (PARTITION BY ${source.partitionColumns.join(', ')} ` +
      `ORDER BY ${windowOrder}) AS ${escape('__rn')}`,
  ];

  const derived =
    `SELECT ${selected.join(', ')} FROM ${source.from}` + (where ? ` WHERE ${where}` : '');

  const parameters: Record<string, number> = {};
  const range: string[] = [];
  const skip = typeof include.skip === 'number' ? include.skip : 0;

  if (hasSkip) {
    parameters[`${childAlias}__skip`] = skip;
    range.push(`${rowNumber} > :${childAlias}__skip`);
  }

  if (hasLimit) {
    // Верхняя граница — абсолютный номер строки, поэтому смещение прибавляется здесь.
    // `$top=0` даёт границу, равную смещению: вместе с `> :skip` это пустая страница,
    // как и требует OData v4 (раздел 11.2.6.4).
    parameters[`${childAlias}__end`] = skip + (include.limit as number);
    range.push(`${rowNumber} <= :${childAlias}__end`);
  }

  if (useIn) {
    const outerKey = source.outerKeyColumns[0] as string;

    return {
      condition:
        `${outerKey} IN (SELECT ${escape(pageAlias)}.${escape('__k0')} ` +
        `FROM (${derived}) ${escape(pageAlias)} WHERE ${range.join(' AND ')})`,
      parameters,
    };
  }

  const correlation = [
    ...source.parentColumns.map(
      (column, i) => `${escape(pageAlias)}.${escape(`__p${i}`)} = ${column}`
    ),
    ...source.outerKeyColumns.map(
      (column, i) => `${escape(pageAlias)}.${escape(`__k${i}`)} = ${column}`
    ),
  ];

  return {
    condition:
      `EXISTS (SELECT 1 FROM (${derived}) ${escape(pageAlias)} ` +
      `WHERE ${[...correlation, ...range].join(' AND ')})`,
    parameters,
  };
}
