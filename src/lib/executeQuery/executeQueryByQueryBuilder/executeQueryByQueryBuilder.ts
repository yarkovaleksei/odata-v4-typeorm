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
import { ODataInvalidQueryError } from '../../errors';
import type { TypeOrmVisitor } from '../../TypeOrmVisitor';
import { applyNestedPagination } from '../applyNestedPagination';
import type { QueryParams } from '../../types';
import { mapToObject } from '../mapToObject';
import { processIncludes } from '../processIncludes';
import { processSearch } from '../processSearch';
import { queryToOdataString } from '../queryToOdataString';
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
      throw new ODataInvalidQueryError('$expand', `navigation not allowed: ${forbidden.join(', ')}`);
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
 * Выполняет запрос с помощью QueryBuilder с поддержкой OData-подобных параметров.
 *
 * @param inputQueryBuilder - исходный QueryBuilder. Может быть уже с условиями: все условия
 *   из OData добавляются через `andWhere`, поэтому предустановленный `where` сохраняется и работает
 *   как обязательный фильтр (типовой способ ограничить выдачу правами пользователя).
 * @param query - объект параметров запроса (например, `{ $search: 'text', $top: '10' }`).
 *   Значения могут быть строками — нормализацией занимается `parseQueryParams`.
 * @param options - опции выполнения: `alias` корневой сущности, `maxTop`, белые списки
 *   `allowedFields` и `allowedExpands`.
 * @returns массив сущностей либо `{ items, count }`, если `$count` не выключен явно.
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
  const { maxTop, allowedFields, allowedExpands } = options ?? {};
  const alias = options?.alias || (inputQueryBuilder.expressionMap.mainAlias?.name ?? '');

  // Пагинацию проверяем до обращения к БД: смысла компилировать заведомо плохой запрос нет.
  assertSkip(parsedQueryWithoutSearch.$skip);

  const top = resolveTop(parsedQueryWithoutSearch.$top, maxTop);

  // Преобразуем параметры в OData-строку и затем в объект odataQuery.
  // Диалект берётся из подключения: от него зависит, какие SQL-функции подставлять
  // для функций OData (LENGTH против LEN, strftime против EXTRACT и т.д.).
  const odataString = queryToOdataString(parsedQueryWithoutSearch);
  const odataQuery = createQuery(odataString, {
    alias,
    dialect: inputQueryBuilder.connection.options.type,
  });

  // Белые списки сверяем сразу после компиляции — до того, как что-либо попадёт в SQL.
  assertAllowed(odataQuery, allowedFields, allowedExpands);

  // Метаданные сущности нужны для трёх вещей: списка колонок SELECT по умолчанию,
  // разрешения связей при обработке $expand и проверки невыбираемых колонок.
  const metadata = resolveMetadata(inputQueryBuilder, alias);

  assertNoHiddenFields(odataQuery, metadata);

  let queryBuilder = inputQueryBuilder;
  let rootSelect: string[];

  // Определяем, какие поля корневой сущности выбирать.
  // NB: `Object.keys(odataQuery).length === 0` — мёртвое условие: odataQuery всегда экземпляр
  // класса TypeOrmVisitor с собственными полями, пустым он не бывает. Реально работает вторая
  // половина: `select === '*'` — это значение базового посетителя, означающее «$select не задан».
  if (Object.keys(odataQuery).length === 0 || odataQuery.select === '*') {
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
  //
  // '1' — значение orderby по умолчанию у базового посетителя (SQL `ORDER BY 1`),
  // здесь оно трактуется как «$orderby не задан».
  if (odataQuery.orderby && odataQuery.orderby !== '1') {
    const orders: string[] = odataQuery.orderby.split(',').map((i: string) => i.trim());

    orders.forEach((orderItem) => {
      // Посетитель нормализует направление к верхнему регистру, так что split по пробелу
      // даёт ['user.name', 'ASC']. Для поля без направления order будет undefined —
      // TypeORM в этом случае подставит ASC.
      const [field, order] = orderItem.split(' ');

      queryBuilder = queryBuilder.addOrderBy(field, order as 'ASC' | 'DESC');
    });
  }

  // Разворачиваем дерево includes в LEFT JOIN'ы ($expand); сортировки связей допишутся
  // после корневой и будут упорядочивать записи внутри каждого родителя.
  queryBuilder = processIncludes<T>(queryBuilder, odataQuery, alias, metadata);

  // $search: регистронезависимый LIKE по текстовым колонкам + точное равенство по числовым.
  // processSearch мутирует queryBuilder на месте и ничего не возвращает.
  if ($search) {
    processSearch<T>(queryBuilder, metadata, $search, alias);
  }

  // skip() вызывается всегда, в том числе с нулём: для TypeORM skip(0) эквивалентен отсутствию
  // смещения и не переводит запрос в режим пагинации через подзапрос.
  queryBuilder = queryBuilder.skip(parsedQueryWithoutSearch.$skip);

  // Проверка именно на undefined, а не на истинность: `$top=0` по OData v4 (раздел 11.2.6.4) —
  // корректный запрос пустой страницы, и его нельзя приравнивать к отсутствию лимита.
  // TypeORM корректно обрабатывает take(0): вернётся ноль строк, а count при $count=true
  // по-прежнему посчитает всю выборку.
  if (top !== undefined) {
    queryBuilder = queryBuilder.take(top);
  }

  // $count по умолчанию true (см. parseQueryParams), поэтому форма ответа по умолчанию —
  // объект { items, count }, а не массив. Это отличается от спецификации OData.
  if (parsedQueryWithoutSearch.$count) {
    // getManyAndCount делает два запроса: страницу данных и COUNT по тем же условиям без limit/offset.
    const resultData = await queryBuilder.getManyAndCount();

    return {
      // count считает корневые сущности и вложенной пагинацией не затрагивается.
      items: applyNestedPagination(resultData[0], odataQuery.includes),
      count: resultData[1],
    };
  }

  return applyNestedPagination(await queryBuilder.getMany(), odataQuery.includes);
};
