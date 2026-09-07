/**
 * @file Основной конвейер выполнения OData поверх `SelectQueryBuilder`.
 *
 * 1. `parseQueryParams` — нормализация типов и выделение `$search`. `$search` не входит в стандартный
 *    OData-грамматический разбор этой библиотеки и реализован отдельно, поэтому он сразу
 *    отделяется от остальных параметров деструктуризацией.
 * 2. `queryToOdataString` — остальные `$...` поля склеиваются обратно в query string для парсера.
 *    Шаг выглядит избыточным (объект → строка → AST), но `odata-v4-parser` принимает только строку.
 * 3. `createQuery` — строка → AST → `TypeOrmVisitor` с SQL-фрагментами и деревом `includes` для `$expand`.
 * 4. По метаданным сущности формируется список колонок SELECT, накладываются WHERE/параметры, JOIN-ы,
 *    сортировка, затем опционально `$search`, пагинация и либо `getMany`, либо `getManyAndCount`.
 * 5. `applyNestedPagination` — срез вложенных `$top` / `$skip` уже над деревом сущностей:
 *    в SQL ограничить число связанных строк на каждого родителя одним запросом нельзя.
 *
 * Порядок шагов 3–4 важен: `$expand` должен быть разобран раньше `$filter`, иначе фильтр по пути
 * `связь/поле` не найдёт JOIN-алиас. За это отвечает `TypeOrmVisitor.queryOptionsSort`.
 */
import type { EntityMetadata, ObjectLiteral, SelectQueryBuilder } from 'typeorm';

import { createQuery } from '../../createQuery';
import { ODataInvalidQueryError, ODataUnsupportedError } from '../../errors';
import { type TypeOrmVisitor, VISITOR_DEFAULTS } from '../../TypeOrmVisitor';
import { applyNestedPagination } from '../applyNestedPagination';
import { applyOrderBy } from '../applyOrderBy';
import { withAutoExpand } from '../autoExpand';
import type { ColumnTypeResolver, QueryParams } from '../../types';
import { mapToObject } from '../mapToObject';
import { processIncludes } from '../processIncludes';
import { processSearch } from '../processSearch';
import { resolveEdmType } from '../../metadata/edmType';
import { createRelationResolver } from '../relationSource';
import { queryToOdataString } from '../queryToOdataString';
import { createEscape } from '../sqlIdentifier';
import type { ExecuteQueryOptions, GetManyResponse } from '../types';
import { parseQueryParams } from './parseQueryParams';

/**
 * Метаданные одной колонки.
 *
 * Тип выводится из `EntityMetadata`, а не импортируется по пути
 * `typeorm/metadata/ColumnMetadata`: карта `exports` в TypeORM не публикует внутренние
 * модули, и такой импорт не разрешается.
 */
type ColumnMetadata = EntityMetadata['columns'][number];

/**
 * Метаданные корневой сущности.
 *
 * Основной путь — взять их у самого построителя. Это снимает давнее ограничение, при котором
 * `alias` обязан был совпадать с именем сущности: раньше метаданные искались через
 * `connection.getMetadata(alias)`, и привычный `createQueryBuilder('u')` падал с
 * `No metadata for "u" was found` (дефект A-03).
 *
 * Запасной путь через `getMetadata(alias)` нужен для построителей без собственных метаданных —
 * например когда корнем выступает подзапрос.
 */
function resolveMetadata<T extends ObjectLiteral>(
  queryBuilder: SelectQueryBuilder<T>,
  alias: string
): EntityMetadata {
  const mainAlias = queryBuilder.expressionMap.mainAlias;

  if (mainAlias?.hasMetadata) {
    return mainAlias.metadata;
  }

  return queryBuilder.connection.getMetadata(alias);
}

/**
 * Находит метаданные колонки по пути свойства, проходя по связям.
 *
 * @param metadata - метаданные корневой сущности.
 * @param path - путь вида `'name'` либо `'books/reviews/score'`.
 * @returns метаданные колонки; `undefined`, если путь ведёт к связи, а не к колонке,
 *   либо не существует вовсе (последнее не ошибка на этом уровне — несуществующее имя
 *   отсеет сама СУБД).
 */
function findColumn(metadata: EntityMetadata, path: string): ColumnMetadata | undefined {
  const segments = path.split('/');
  const field = segments.pop() as string;

  let current = metadata;

  for (const navigation of segments) {
    const relation = current.relations.find((r) => r.propertyPath === navigation);

    if (!relation) {
      return undefined;
    }

    current = relation.inverseEntityMetadata;
  }

  return current.columns.find((column) => column.propertyPath === field);
}

/**
 * Собирает хук `resolveColumnType` для компилятора: путь свойства → примитивный тип EDM.
 *
 * Обе половины уже есть: `findColumn` проходит по связям, `resolveEdmType` переводит тип
 * колонки TypeORM в тип EDM по той же таблице, по которой строится документ `$metadata`.
 * Не хватало только канала до компилятора — им и стал этот хук (R-44).
 *
 * Единственный потребитель — `cast`: по типу исходной колонки видно, может ли приведение
 * провалиться. Незнакомый тип колонки `resolveEdmType` описывает как `Edm.String`, и это
 * согласовано с `$metadata`: там он описан так же.
 */
function createColumnTypeResolver(metadata: EntityMetadata): ColumnTypeResolver {
  return (path) => {
    const column = findColumn(metadata, path);

    return column ? resolveEdmType(column) : undefined;
  };
}

/**
 * Запрещает обращаться к колонкам, помеченным `@Column({ select: false })`.
 *
 * Такая пометка — способ TypeORM сказать «эта колонка не покидает сервер по умолчанию»;
 * типовое применение — хеши паролей и токены. Собственный `find()` в TypeORM их скрывает,
 * а эта библиотека раньше возвращала их **на каждом запросе**, потому что строила список
 * SELECT из всех невиртуальных колонок и тем самым явно переопределяла умолчание TypeORM.
 * См. `docs/audit.md`, дефект A-12.
 *
 * Проверяются все упоминания — `$select`, `$filter` и `$orderby`: фильтр по скрытой колонке
 * не возвращает её значение, но работает как оракул для подбора (`passwordHash eq '…'`
 * отвечает разным числом строк).
 *
 * @throws {ODataInvalidQueryError} если запрос обращается к невыбираемой колонке.
 */
function assertNoHiddenFields(odataQuery: TypeOrmVisitor, metadata: EntityMetadata): void {
  const hidden = odataQuery
    .collectReferencedFields()
    .filter((path) => findColumn(metadata, path)?.isSelect === false);

  if (hidden.length) {
    throw new ODataInvalidQueryError('$select', `field is not selectable: ${hidden.join(', ')}`);
  }
}

/**
 * Префикс служебных алиасов, под которыми первичный ключ корня попадает в «сырой» результат.
 *
 * Своё имя, а не готовый алиас TypeORM (`Author_id`): тот строится внутренним `buildAlias`,
 * который при длинных именах переходит на хеш и в публичный API пакета не выведен. Угадывать
 * правило значило бы поставить сопоставление строк в зависимость от длины имени сущности.
 */
const KEY_ALIAS_PREFIX = 'odata_computed_key_';

/**
 * Разделитель значений составного ключа при сопоставлении строк с сущностями.
 *
 * Нулевой символ, а не пробел или дефис: значения ключа приводятся к строке, и любой
 * печатный разделитель может встретиться внутри самого значения — тогда две разные пары
 * ключей дали бы одну строку. Записан escape-последовательностью намеренно: литеральный
 * символ в исходнике невидим в редакторе, а файл с ним считается двоичным.
 */
const KEY_SEPARATOR = '\u0000';

/**
 * Отвергает вычисляемые выражения, у которых нет одного значения на строку ответа.
 *
 * Путь через связь «ко многим» в `$select` не имеет смысла: значение считается по каждой
 * связанной строке, и в плоском результате их столько же. Отдать любое из них (скажем, первое)
 * значило бы молча выдать за ответ одно из нескольких — ровно то расхождение, которого
 * библиотека избегает везде. В `$filter` и `$orderby` тот же путь допустим: там он ведёт себя
 * как обычное условие по соединённой связи, и это давнее поведение.
 *
 * @throws {ODataInvalidQueryError} если выражение проходит через связь «ко многим».
 */
function assertComputedIsSingleValued(odataQuery: TypeOrmVisitor, metadata: EntityMetadata): void {
  for (const { name } of odataQuery.computedSelects) {
    for (const path of odataQuery.computedFields.get(name) ?? []) {
      const segments = path.split('/');

      segments.pop();

      let current = metadata;

      for (const navigation of segments) {
        const relation = current.relations.find((r) => r.propertyPath === navigation);

        if (!relation) {
          break;
        }

        if (!relation.isManyToOne && !relation.isOneToOne) {
          throw new ODataInvalidQueryError(
            '$compute',
            `expression selected as "${name}" goes through a collection: ${path}`
          );
        }

        current = relation.inverseEntityMetadata;
      }
    }
  }
}

/**
 * Первичный ключ корня в виде путей свойств: `['Author.id']`.
 *
 * Составной ключ даёт несколько путей — отсюда массив, а не одно значение.
 */
function primaryKeyPaths(metadata: EntityMetadata, alias: string): string[] {
  return metadata.primaryColumns.map((column) => `${alias}.${column.propertyPath}`);
}

/**
 * Нужен ли первичный ключ в выборке помимо того, что запросил клиент.
 *
 * Две причины, обе техническе, и обе не зависят от того, назвал ли ключ `$select`.
 *
 * **Вычисленные значения `$compute`.** Они приходят из плоского результата отдельно
 * от сущностей, и найти свою строку значение может только по ключу.
 *
 * **Пагинация вместе с соединениями.** При `take` или `skip` и хотя бы одном `JOIN` TypeORM
 * выполняет запрос в два приёма: сначала выбирает ключи нужной страницы подзапросом
 * `SELECT DISTINCT "distinctAlias"."<алиас>_<ключ>" FROM (<исходный запрос>)`. Ключа нет
 * во внутреннем запросе — нет и колонки, на которую ссылается внешний: запрос падает
 * ошибкой уровня СУБД (`no such column: distinctAlias.Author_id`). Условие здесь повторяет
 * условие внутри `SelectQueryBuilder.executeEntitiesAndRawResults`.
 *
 * Соединения считаются и по дереву `includes` (`$expand` плюс «виртуальные» связи из путей
 * в `$filter` и `$orderby`), и по самому построителю: вызывающий код мог добавить свои
 * `leftJoin` до вызова. Лямбда-операторы соединений не создают — они разворачиваются
 * в `EXISTS`, — и на это условие не влияют.
 */
function needsPrimaryKey<T extends ObjectLiteral>(
  queryBuilder: SelectQueryBuilder<T>,
  odataQuery: TypeOrmVisitor,
  paginated: boolean
): boolean {
  if (odataQuery.computedSelects.length > 0) {
    return true;
  }

  const hasJoins =
    odataQuery.includes.length > 0 || queryBuilder.expressionMap.joinAttributes.length > 0;

  return paginated && hasJoins;
}

/**
 * Убирает из сущностей колонки ключа, которых клиент не просил.
 *
 * Ключ добавляется в выборку по техническим причинам (см. {@link needsPrimaryKey}), а форму
 * ответа определяет `$select`: `$select=name` обязан вернуть одно `name` — и возвращает его
 * без пагинации, значит обязан и с ней. Иначе форма ответа зависела бы от того, добавил ли
 * клиент `$top`, то есть от обстоятельства, к составу полей отношения не имеющего.
 *
 * @param added - пути свойств, добавленные сверх запрошенных; пустой массив ничего не меняет.
 */
function stripAddedKeys<T extends ObjectLiteral>(items: T[], added: readonly string[]): T[] {
  if (added.length === 0) {
    return items;
  }

  // Путь вида `Author.id` — интересует только имя свойства после алиаса.
  const properties = added.map((path) => path.slice(path.indexOf('.') + 1));

  for (const item of items) {
    for (const property of properties) {
      delete (item as ObjectLiteral)[property];
    }
  }

  return items;
}

/**
 * Где в дереве ответа лежит уровень, которому принадлежит SQL-алиас.
 *
 * @property path - путь связей от корня: `[]` для корня, `['books', 'reviews']` для связи.
 * @property chain - посетители того же пути; по ним видно, попадает ли уровень в ответ вообще.
 */
interface AliasLocation {
  path: string[];
  chain: TypeOrmVisitor[];
}

/** Собирает карту «SQL-алиас → место в дереве ответа» по всем уровням `$expand`. */
function indexAliases(
  visitor: TypeOrmVisitor,
  location: AliasLocation = { path: [], chain: [] },
  map = new Map<string, AliasLocation>()
): Map<string, AliasLocation> {
  map.set(visitor.alias, location);

  for (const include of visitor.includes) {
    indexAliases(
      include,
      { path: [...location.path, include.navigationProperty], chain: [...location.chain, include] },
      map
    );
  }

  return map;
}

/** Колонка, добавленная в выборку ради `ORDER BY`, и место, откуда её убрать из ответа. */
interface AddedOrderByColumn {
  location: AliasLocation;
  property: string;
}

/**
 * Добавляет в выборку колонки, по которым идёт сортировка, но которых в ней нет.
 *
 * Нужно по той же причине, что и первичный ключ (см. {@link needsPrimaryKey}): при пагинации
 * вместе с соединением TypeORM выбирает страницу подзапросом
 * `SELECT DISTINCT … FROM (<исходный запрос>) "distinctAlias" ORDER BY "distinctAlias"."<колонка>"`
 * и ссылается на каждую колонку сортировки безусловно — а во внутренний запрос она попадает,
 * только если её выбрали. Отсюда отказы вида `no such column: distinctAlias.Author_books_pages`
 * у `$orderby=books/pages&$top=2`: связь присоединена ради сортировки, но её колонки не нужны
 * ответу и не выбираются.
 *
 * Источник списка — `expressionMap`, а не скомпилированная строка `$orderby`: это ровно тот же
 * список, который читает TypeORM, поэтому разойтись они не могут. Выражения, не являющиеся
 * колонкой (арифметика, вызовы функций), пропускаются — им соответствия в выборке нет;
 * псевдонимы `$compute` до этого места не доходят, они уже приведены к SQL-псевдониму.
 *
 * @returns добавленные колонки, чтобы убрать их из ответа.
 */
function selectOrderByColumns<T extends ObjectLiteral>(
  queryBuilder: SelectQueryBuilder<T>,
  aliases: Map<string, AliasLocation>
): AddedOrderByColumn[] {
  const added: AddedOrderByColumn[] = [];
  const { selects } = queryBuilder.expressionMap;

  for (const criteria of Object.keys(queryBuilder.expressionMap.allOrderBys)) {
    const separator = criteria.indexOf('.');

    if (separator === -1) {
      continue;
    }

    const aliasName = criteria.slice(0, separator);
    const property = criteria.slice(separator + 1);
    const location = aliases.get(aliasName);

    if (!location) {
      // Соединение, добавленное вызывающим кодом до вызова: его колонки не наши,
      // и убирать их из ответа мы тоже не вправе.
      continue;
    }

    // Критерий выбранности повторяет `buildEscapedEntityColumnSelects` в TypeORM: колонка
    // считается выбранной, если выбран весь алиас либо она сама.
    const selected = selects.some(
      (select) => select.selection === aliasName || select.selection === criteria
    );

    if (selected) {
      continue;
    }

    queryBuilder.addSelect(criteria);
    added.push({ location, property });
  }

  return added;
}

/**
 * Убирает из ответа колонки, добавленные ради `ORDER BY`.
 *
 * Уровень, у которого не выбрано ни одной колонки, TypeORM в ответ не собирает вовсе —
 * добавленная колонка делает его видимым целиком. Поэтому связь, попавшая в запрос только
 * ради соединения, снимается с ответа целиком, а у связи, которую запросил `$expand`,
 * убирается одна добавленная колонка.
 */
function stripAddedOrderByColumns<T extends ObjectLiteral>(
  items: T[],
  added: readonly AddedOrderByColumn[]
): T[] {
  for (const { location, property } of added) {
    // Первый уровень пути, которого в ответе быть не должно: связь присоединена ради
    // сортировки или фильтра, а `$expand` её не запрашивал.
    const virtualAt = location.chain.findIndex((visitor) => visitor.select === '');

    if (virtualAt === -1) {
      forEachAtPath(items, location.path, (target) => delete (target as ObjectLiteral)[property]);

      continue;
    }

    const parentPath = location.path.slice(0, virtualAt);
    const relation = location.path[virtualAt] as string;

    forEachAtPath(items, parentPath, (target) => delete (target as ObjectLiteral)[relation]);
  }

  return items;
}

/**
 * Применяет действие к каждому объекту по пути связей от корня.
 *
 * Связь бывает и массивом («ко многим»), и объектом («к одному»), и `null` у строки,
 * которой соответствия не нашлось, — обход учитывает все три случая.
 */
function forEachAtPath(
  items: readonly unknown[],
  path: readonly string[],
  action: (target: object) => void
): void {
  let current: unknown[] = [...items];

  for (const segment of path) {
    const next: unknown[] = [];

    for (const item of current) {
      const value = (item as ObjectLiteral | null)?.[segment];

      if (Array.isArray(value)) {
        next.push(...value);
      } else if (value) {
        next.push(value);
      }
    }

    current = next;
  }

  for (const target of current) {
    if (target && typeof target === 'object') {
      action(target as object);
    }
  }
}

/**
 * Добавляет в выборку вычисленные значения, по которым идёт сортировка.
 *
 * В `ORDER BY` посетитель пишет SQL-псевдоним, а не выражение, — значит выражение обязано
 * быть в `SELECT` под этим псевдонимом. На форму ответа это не влияет: колонки сущности
 * у выражения нет, и сборщик сущностей TypeORM её не подхватывает.
 */
function selectComputedOrderBy<T extends ObjectLiteral>(
  queryBuilder: SelectQueryBuilder<T>,
  visitor: TypeOrmVisitor
): void {
  for (const [name, sql] of visitor.computedOrderBy) {
    queryBuilder.addSelect(sql, visitor.computedOrderByAlias(name));
  }

  for (const include of visitor.includes) {
    selectComputedOrderBy(queryBuilder, include);
  }
}

/**
 * Отвергает `$compute` в `$select` внутри `$expand`.
 *
 * Вычисленные значения материализуются только для корня: они собираются из «сырого» результата
 * по первичному ключу корневой сущности, а для связи пришлось бы раскладывать значения
 * по элементам каждой коллекции отдельно. Пока это не сделано, псевдоним в таком `$select`
 * просто не доезжал бы до ответа — то есть запрос выполнялся бы не так, как написан,
 * без единого признака.
 *
 * @throws {ODataUnsupportedError} если вложенный `$select` называет псевдоним `$compute`.
 */
function assertNoComputedSelectInExpand(visitor: TypeOrmVisitor): void {
  for (const include of visitor.includes) {
    const [computed] = include.computedSelects;

    if (computed) {
      throw new ODataUnsupportedError(
        '$compute alias in $select inside $expand',
        `${include.navigationProperty}($select=${computed.name})`
      );
    }

    assertNoComputedSelectInExpand(include);
  }
}

/**
 * Убирает из ответа всё, что библиотека добавила в выборку ради SQL.
 *
 * Две причины добавления — первичный ключ и колонки сортировки — снимаются вместе и в одном
 * месте: обе одинаково не должны влиять на форму ответа, которую задаёт `$select`.
 */
function stripAdded<T extends ObjectLiteral>(
  items: T[],
  addedKeys: readonly string[],
  addedOrderByColumns: readonly AddedOrderByColumn[]
): T[] {
  return stripAddedOrderByColumns(stripAddedKeys(items, addedKeys), addedOrderByColumns);
}

/**
 * Приводит `$top` к разрешённому диапазону.
 *
 * Отрицательное значение — ошибка клиента: TypeORM молча игнорирует `take(-5)` и возвращает
 * всё, то есть запрос выполнился бы не так, как просили, без единого признака.
 * Превышение `maxTop` не ошибка, а штатное усечение страницы: так ведёт себя большинство
 * OData-серверов, и клиенту не нужно знать лимит заранее.
 *
 * @throws {ODataInvalidQueryError} при отрицательном `$top`.
 */
function resolveTop(top: number | undefined, maxTop: number | undefined): number | undefined {
  if (top === undefined) {
    return undefined;
  }

  if (top < 0) {
    throw new ODataInvalidQueryError('$top', 'value must not be negative');
  }

  return maxTop !== undefined && top > maxTop ? maxTop : top;
}

/**
 * Проверяет `$skip`.
 *
 * @throws {ODataInvalidQueryError} при отрицательном значении.
 */
function assertSkip(skip: number): void {
  if (skip < 0) {
    throw new ODataInvalidQueryError('$skip', 'value must not be negative');
  }
}

/**
 * Драйверы, которые не умеют `OFFSET` без `LIMIT`.
 *
 * Список повторяет условие внутри `SelectQueryBuilder.createLimitOffsetExpression`
 * в TypeORM: для них построитель заранее бросает `OffsetWithoutLimitNotSupportedError`.
 * PostgreSQL такой запрос принимает, SQLite подставляет `LIMIT -1`.
 */
const DRIVERS_REQUIRING_LIMIT_WITH_OFFSET = ['mysql', 'mariadb', 'aurora-mysql', 'sap', 'spanner'];

/**
 * Лимит-заглушка для `$skip` без `$top`.
 *
 * `$skip=10` без `$top` — совершенно обычный запрос OData, но на MySQL он не выполняется:
 * `OFFSET` там требует `LIMIT`. Общепринятый обходной путь — поставить заведомо
 * недостижимый лимит. `Number.MAX_SAFE_INTEGER` для этого годится: он умещается
 * в 64-битное целое MySQL и на порядки превышает любой реальный размер таблицы.
 *
 * @returns значение для `take()` либо `undefined`, если подстраховка не нужна.
 */
function resolveOffsetGuardLimit<T extends ObjectLiteral>(
  queryBuilder: SelectQueryBuilder<T>,
  skip: number,
  top: number | undefined
): number | undefined {
  if (skip <= 0 || top !== undefined) {
    return undefined;
  }

  const driver = queryBuilder.connection.options.type;

  return DRIVERS_REQUIRING_LIMIT_WITH_OFFSET.includes(driver) ? Number.MAX_SAFE_INTEGER : undefined;
}

/**
 * Сверяет затронутые запросом поля и связи с белыми списками.
 *
 * Проверка идёт по скомпилированному запросу, а не по исходным строкам параметров: посетитель
 * во время обхода собрал точный перечень путей, тогда как разбор `$filter` регулярными
 * выражениями пропустил бы поля внутри функций и арифметики.
 *
 * Списки не заданы — проверка не выполняется, поведение остаётся прежним.
 *
 * @throws {ODataInvalidQueryError} если запрос обращается к полю или связи вне списка.
 */
function assertAllowed(
  odataQuery: TypeOrmVisitor,
  allowedFields?: readonly string[],
  allowedExpands?: readonly string[]
): void {
  if (allowedExpands) {
    const forbidden = odataQuery
      .collectNavigationProperties()
      .filter((navigation) => !allowedExpands.includes(navigation));

    if (forbidden.length) {
      // Наружу отдаём только то, что клиент и так прислал: имена запрошенных связей.
      // Разрешённый список не раскрываем — это подсказка для перебора схемы.
      throw new ODataInvalidQueryError(
        '$expand',
        `navigation not allowed: ${forbidden.join(', ')}`
      );
    }
  }

  if (allowedFields) {
    const forbidden = odataQuery
      .collectReferencedFields()
      .filter((field) => !allowedFields.includes(field));

    if (forbidden.length) {
      throw new ODataInvalidQueryError('$select', `field not allowed: ${forbidden.join(', ')}`);
    }
  }
}

/**
 * Материализует вычисленные значения `$compute`, названные в `$select`.
 *
 * ПОЧЕМУ НЕ `getMany()`. `addSelect(<sql>, <алиас>)` даёт колонку, которой нет в сущности,
 * и сборщик сущностей TypeORM такие колонки отбрасывает. Значения приходится забирать
 * из «сырого» результата и раскладывать по сущностям вручную.
 *
 * СОПОСТАВЛЕНИЕ ИДЁТ ПО КЛЮЧУ, А НЕ ПО ИНДЕКСУ. Плоский результат с `LEFT JOIN` содержит
 * по строке на каждую связанную запись, а сущностей столько, сколько корневых строк:
 * у автора с двумя книгами `raw` длиннее `entities` уже на единицу, и позиции расходятся.
 * Поэтому первичный ключ корня уезжает в результат под собственным алиасом, и значение
 * находится по нему.
 *
 * @returns сущности с дописанными свойствами-псевдонимами.
 */
async function selectComputed<T extends ObjectLiteral>(
  queryBuilder: SelectQueryBuilder<T>,
  odataQuery: TypeOrmVisitor,
  metadata: EntityMetadata,
  alias: string
): Promise<T[]> {
  for (const { name, sql } of odataQuery.computedSelects) {
    queryBuilder.addSelect(sql, name);
  }

  const escape = createEscape(queryBuilder.connection);

  const keys = metadata.primaryColumns.map((column, index) => ({
    property: column.propertyPath,
    rawAlias: `${KEY_ALIAS_PREFIX}${index}`,
    // Экранированное имя колонки, а не путь свойства `Author.id`: путь TypeORM разбирает
    // как колонку сущности и добавляет её в SELECT ещё раз, под своим алиасом. В запросе
    // тогда оказываются два `Author_id`, и PostgreSQL отвергает его как неоднозначный.
    sql: `${escape(alias)}.${escape(column.databaseName)}`,
  }));

  for (const key of keys) {
    queryBuilder.addSelect(key.sql, key.rawAlias);
  }

  const { entities, raw } = await queryBuilder.getRawAndEntities();
  const rows = new Map<string, Record<string, unknown>>();

  for (const row of raw as Array<Record<string, unknown>>) {
    const id = keys.map((key) => String(row[key.rawAlias])).join(KEY_SEPARATOR);

    // Первая строка группы: у остальных строк той же корневой сущности вычисленные значения
    // те же самые — выражение опирается только на однозначные пути (см. assertComputedIsSingleValued).
    if (!rows.has(id)) {
      rows.set(id, row);
    }
  }

  for (const entity of entities) {
    const id = keys
      .map((key) => String((entity as ObjectLiteral)[key.property]))
      .join(KEY_SEPARATOR);
    const row = rows.get(id);

    if (!row) {
      continue;
    }

    for (const { name } of odataQuery.computedSelects) {
      (entity as ObjectLiteral)[name] = row[name];
    }
  }

  return entities;
}

/**
 * Выполняет запрос с помощью QueryBuilder с поддержкой OData-подобных параметров.
 *
 * @param inputQueryBuilder - исходный QueryBuilder. Может быть уже с условиями: все условия
 *   из OData добавляются через `andWhere`, поэтому предустановленный `where` сохраняется и работает
 *   как обязательный фильтр (типовой способ ограничить выдачу правами пользователя).
 * @param query - объект параметров запроса (например, `{ $search: 'text', $top: '10' }`).
 *   Значения могут быть строками — нормализацией занимается `parseQueryParams`.
 * @param options - опции выполнения: `alias` корневой сущности, `maxTop`, белые списки
 *   `allowedFields` и `allowedExpands`.
 * @returns массив сущностей либо `{ items, count }`, если передан `$count=true`.
 *
 * @remarks `alias` может быть любым: метаданные берутся у самого построителя. Поиск через
 *   `connection.getMetadata(alias)` остаётся запасным путём — тогда алиас должен совпадать
 *   с именем сущности или таблицы.
 *
 * @throws {ODataParseError} некорректный синтаксис OData-параметров.
 * @throws {ODataUnsupportedError} конструкция вне поддерживаемого подмножества OData.
 * @throws {ODataInvalidQueryError} отрицательный `$top` / `$skip` либо обращение к полю
 *   или связи вне белого списка.
 * @throws {EntityMetadataNotFoundError} у построителя нет метаданных и `alias` не соответствует
 *   ни одной сущности.
 * @throws {QueryFailedError} в `$filter` / `$orderby` указана несуществующая колонка: имена полей
 *   по метаданным не проверяются и попадают в запрос как есть.
 */
export const executeQueryByQueryBuilder = async <T extends ObjectLiteral = ObjectLiteral>(
  inputQueryBuilder: SelectQueryBuilder<T>,
  query: QueryParams,
  options: ExecuteQueryOptions = {}
): Promise<T[] | GetManyResponse<T>> => {
  // $search отделяется сразу: он реализован собственным SQL (processSearch), а не через OData AST,
  // поэтому в строку для парсера попасть не должен.
  const { $search, ...parsedQueryWithoutSearch } = parseQueryParams(query);

  // Нормализуем опции: alias берём из options, иначе — из корневого алиаса самого QueryBuilder.
  const {
    maxTop,
    allowedFields,
    allowedExpands,
    searchFields,
    searchMode,
    searchLanguage,
    autoExpand = false,
    nestedPaginationInSql = true,
  } = options ?? {};
  const alias = options?.alias || (inputQueryBuilder.expressionMap.mainAlias?.name ?? '');

  // Пагинацию проверяем до обращения к БД: смысла компилировать заведомо плохой запрос нет.
  assertSkip(parsedQueryWithoutSearch.$skip);

  const top = resolveTop(parsedQueryWithoutSearch.$top, maxTop);

  // Преобразуем параметры в OData-строку и затем в объект odataQuery.
  // Диалект берётся из подключения: от него зависит, какие SQL-функции подставлять
  // для функций OData (LENGTH против LEN, strftime против EXTRACT и т.д.).
  // Метаданные сущности нужны для пяти вещей: списка колонок SELECT по умолчанию,
  // разрешения связей при обработке $expand, проверки невыбираемых колонок, подзапросов
  // лямбда-операторов и типов колонок для `cast` — последним двум нужны имена таблиц
  // и типы, которых компилятор OData не знает.
  const metadata = resolveMetadata(inputQueryBuilder, alias);

  // `autoExpand` дописывает связи корня прямо в `$expand` — до разбора, а не после: так
  // автоматические связи проходят тот же путь, что и присланные клиентом, и отдельной ветки
  // в конвейере не появляется. Названные клиентом связи сохраняются вместе со своими опциями.
  const expand = autoExpand
    ? withAutoExpand(parsedQueryWithoutSearch.$expand, metadata, allowedExpands)
    : parsedQueryWithoutSearch.$expand;

  const odataString = queryToOdataString({ ...parsedQueryWithoutSearch, $expand: expand });
  const odataQuery = createQuery(odataString, {
    alias,
    dialect: inputQueryBuilder.connection.options.type,
    resolveRelation: createRelationResolver(inputQueryBuilder.connection, metadata),
    resolveColumnType: createColumnTypeResolver(metadata),
  });

  // Белые списки сверяем сразу после компиляции — до того, как что-либо попадёт в SQL.
  assertAllowed(odataQuery, allowedFields, allowedExpands);

  assertNoHiddenFields(odataQuery, metadata);

  assertComputedIsSingleValued(odataQuery, metadata);

  assertNoComputedSelectInExpand(odataQuery);

  let queryBuilder = inputQueryBuilder;
  let rootSelect: string[];

  // `$select` перечислил только псевдонимы `$compute`: колонок в нём нет, и посетитель оставил
  // `select` пустым, то есть равным умолчанию. Выбирать при этом всю сущность значило бы
  // вернуть больше, чем просили, — в SELECT уходит только ключ, добавленный ниже.
  const computedOnlySelect =
    odataQuery.computedSelects.length > 0 && odataQuery.select === VISITOR_DEFAULTS.select;

  // Определяем, какие поля корневой сущности выбирать.
  // `select === '*'` — значение посетителя по умолчанию, означающее «$select не задан».
  if (computedOnlySelect) {
    rootSelect = [];
  } else if (odataQuery.select === VISITOR_DEFAULTS.select) {
    // $select не задан: берём все невыбираемые-по-умолчанию колонки корня.
    //
    // nonVirtualColumns исключает вычисляемые поля (@VirtualColumn), для которых нет столбца в БД.
    // Фильтр по isSelect исключает колонки с `@Column({ select: false })` — без него список
    // передавался в .select() целиком и явно переопределял умолчание TypeORM, из-за чего
    // хеш пароля возвращался в каждом ответе (дефект A-12).
    rootSelect = metadata.nonVirtualColumns
      .filter((column) => column.isSelect)
      .map((x) => `${alias}.${x.propertyPath}`);
  } else {
    // $select задан: посетитель уже вернул поля с префиксом алиаса ('user.id, user.name'),
    // поэтому здесь только разбиение и обрезка пробелов.
    rootSelect = odataQuery.select.split(',').map((x: string) => x.trim());
  }

  // Первичный ключ бывает нужен самой библиотеке — вычисленным значениям и двухшаговой
  // пагинации TypeORM (см. needsPrimaryKey). Он дописывается в выборку и убирается из ответа
  // перед возвратом, поэтому на форму ответа не влияет: её по-прежнему задаёт один `$select`.
  const paginated = top !== undefined || parsedQueryWithoutSearch.$skip > 0;
  const addedKeys =
    needsPrimaryKey(inputQueryBuilder, odataQuery, paginated) &&
    odataQuery.select !== VISITOR_DEFAULTS.select
      ? primaryKeyPaths(metadata, alias).filter((path) => !rootSelect.includes(path))
      : [];

  // computedOnlySelect — тот же случай: `select` равен умолчанию только потому, что в нём
  // не осталось колонок, и всю сущность выбирать нельзя.
  if (computedOnlySelect) {
    addedKeys.push(...primaryKeyPaths(metadata, alias));
  }

  rootSelect.push(...addedKeys);

  // select() (а не addSelect) сбрасывает выборку, заданную вызывающим кодом до этого момента.
  queryBuilder = queryBuilder.select(rootSelect);

  // andWhere, а не where: предустановленные условия входного QueryBuilder не затираются.
  // Для пустого $filter посетитель отдаёт '1 = 1' — нейтральное условие, ломать AND им нечего.
  queryBuilder = queryBuilder
    .andWhere(odataQuery.where)
    .setParameters(mapToObject(odataQuery.parameters));

  // ПОРЯДОК ВАЖЕН: корневая сортировка добавляется ДО processIncludes.
  //
  // `addOrderBy` дописывает выражения в конец `ORDER BY`, а результат запроса с `LEFT JOIN`
  // плоский: сортировка связи, оказавшись первой, начинает управлять порядком корневых строк.
  // Раньше processIncludes шёл раньше, и `$expand=books($orderby=id)&$orderby=id` давал
  // `ORDER BY Author_books.id, Author.id` — авторы без книг всплывали наверх (у них NULL),
  // то есть корневой `$orderby` переставал работать. См. `docs/audit.md`, дефект A-14.
  queryBuilder = applyOrderBy(queryBuilder, odataQuery.orderby);

  // Разворачиваем дерево includes в LEFT JOIN'ы ($expand); сортировки связей допишутся
  // после корневой и будут упорядочивать записи внутри каждого родителя.
  //
  // Сюда же переносится вложенная пагинация: `$expand=books($top=2)` превращается в условие
  // с оконной функцией на ON соединения. Связи, для которых это удалось, попадают в
  // `paginatedInSql` — их нельзя резать второй раз в памяти.
  const paginatedInSql = new Set<TypeOrmVisitor>();

  queryBuilder = processIncludes<T>(queryBuilder, odataQuery, alias, metadata, {
    paginated: paginatedInSql,
    enabled: nestedPaginationInSql,
  });

  // Сортировка по вычисленному значению ссылается на SQL-псевдоним — значит выражение
  // обязано быть в SELECT под этим именем. На форму ответа не влияет: колонки сущности
  // у выражения нет. Делается после processIncludes: у вложенных уровней свои псевдонимы.
  selectComputedOrderBy(queryBuilder, odataQuery);

  // Колонки, по которым идёт сортировка, обязаны быть в выборке, иначе двухшаговая пагинация
  // TypeORM сошлётся на несуществующую колонку. Шаг идёт последним из тех, что трогают SELECT
  // и ORDER BY: к этому моменту в построителе уже все сортировки — и корня, и связей.
  const addedOrderByColumns = paginated
    ? selectOrderByColumns(queryBuilder, indexAliases(odataQuery))
    : [];

  // $search: выражение разбирается по грамматике OData (AND / OR / NOT, фразы, скобки),
  // термы проверяются по колонкам корня либо по перечисленным в `searchFields` полям.
  // processSearch мутирует queryBuilder на месте и ничего не возвращает.
  if ($search) {
    processSearch<T>(queryBuilder, metadata, $search, alias, {
      fields: searchFields,
      mode: searchMode,
      language: searchLanguage,
    });
  }

  // skip() вызывается ТОЛЬКО при ненулевом смещении.
  //
  // Раньше он вызывался безусловно, и `skip(0)` без `take` давал `OFFSET 0` без `LIMIT`.
  // SQLite и PostgreSQL такой запрос принимают, а MySQL — нет: TypeORM заранее бросает
  // `OffsetWithoutLimitNotSupportedError`, и на MySQL падал вообще любой запрос без `$top`.
  // Смысл при этом не теряется: нулевое смещение и отсутствие смещения — одно и то же.
  // См. `docs/audit.md`, дефект A-15.
  if (parsedQueryWithoutSearch.$skip > 0) {
    queryBuilder = queryBuilder.skip(parsedQueryWithoutSearch.$skip);
  }

  // Проверка именно на undefined, а не на истинность: `$top=0` по OData v4 (раздел 11.2.6.4) —
  // корректный запрос пустой страницы, и его нельзя приравнивать к отсутствию лимита.
  // TypeORM корректно обрабатывает take(0): вернётся ноль строк, а count при $count=true
  // по-прежнему посчитает всю выборку.
  const guardLimit = resolveOffsetGuardLimit(queryBuilder, parsedQueryWithoutSearch.$skip, top);

  if (top !== undefined) {
    queryBuilder = queryBuilder.take(top);
  } else if (guardLimit !== undefined) {
    // `$skip` без `$top` на MySQL требует хоть какого-то `LIMIT` — см. resolveOffsetGuardLimit.
    queryBuilder = queryBuilder.take(guardLimit);
  }

  // Вычисленные значения `$compute` в `$select` требуют «сырого» результата: обычный сборщик
  // сущностей отбрасывает колонки, которых нет в сущности. Отдельная ветка целиком, чтобы
  // запросы без `$compute` шли прежним путём — вплоть до того же вызова `getManyAndCount()`.
  if (odataQuery.computedSelects.length > 0) {
    const items = await selectComputed(queryBuilder, odataQuery, metadata, alias);
    // Ключ снимается после selectComputed: именно по нему там значение находит свою сущность.
    const page = stripAdded(
      applyNestedPagination(items, odataQuery.includes, paginatedInSql),
      addedKeys,
      addedOrderByColumns
    );

    if (!parsedQueryWithoutSearch.$count) {
      return page;
    }

    // `getManyAndCount()` «сырого» варианта не имеет, поэтому счётчик считается отдельным
    // вызовом. Число получается то же: `getCount()` так же игнорирует `take` и `skip`.
    return { items: page, count: await queryBuilder.getCount() };
  }

  // $count по умолчанию false (см. parseQueryParams), как требует OData v4: без явного
  // запроса счётчика возвращается обычный массив и выполняется один запрос вместо двух.
  if (parsedQueryWithoutSearch.$count) {
    // getManyAndCount делает два запроса: страницу данных и COUNT по тем же условиям без limit/offset.
    const resultData = await queryBuilder.getManyAndCount();

    return {
      // count считает корневые сущности и вложенной пагинацией не затрагивается.
      items: stripAdded(
        applyNestedPagination(resultData[0], odataQuery.includes, paginatedInSql),
        addedKeys,
        addedOrderByColumns
      ),
      count: resultData[1],
    };
  }

  return stripAdded(
    applyNestedPagination(await queryBuilder.getMany(), odataQuery.includes, paginatedInSql),
    addedKeys,
    addedOrderByColumns
  );
};
