/**
 * @file Обход дерева OData с накоплением фрагментов SQL для TypeORM QueryBuilder.
 *
 * Класс накапливает строковые фрагменты SQL (`where`, `select`, `orderby`), лимиты и смещения,
 * карту параметров и дерево `includes` для `$expand`. Раньше он наследовался от `Visitor`
 * из `odata-v4-sql` (последний релиз — 2016 год) и переопределял почти всё, что там было;
 * вместе с уходом от неподдерживаемых зависимостей (R-18) остаток базового класса перенесён
 * сюда. Заодно исчезла машинерия, которая обслуживала только чужой код: диалекты `SQLLang`,
 * перенумерация плейсхолдеров `asType()` и обходы узлов, которых наш парсер не порождает.
 *
 * Что делает этот обход:
 * - порядок обхода query options (`$expand` → `$filter` → `$select`) для согласованных алиасов;
 * - вложенные `$expand` как отдельные экземпляры `TypeOrmVisitor` в массиве `includes`;
 * - пути вида `связь/поле` в фильтрах и сортировке: автоматическое создание «виртуального» expand
 *   только ради JOIN, без выборки лишних колонок;
 * - сравнение с `null` в OData преобразуется в SQL `IS NULL` / `IS NOT NULL`;
 * - логическое отрицание `not`, арифметика (`add`, `sub`, `mul`, `div`, `mod`), унарный минус;
 * - строковые, числовые и календарные функции OData в `WHERE`.
 *
 * ПЛЕЙСХОЛДЕРЫ именованные (`:p0`), потому что их понимает TypeORM QueryBuilder. Позиционных
 * `?` здесь нет вовсе — прежний базовый класс писал их, а потом отдельным проходом
 * перенумеровывал, и на этом проходе рождался дефект A-01: имена, расставленные заранее,
 * он не видел и назначал те же номера повторно.
 *
 * ПРИНЦИП: молча ничего не терять. Узел дерева, для которого нет обработчика, приводит к
 * {@link ODataUnsupportedError}, а не к пропуску части запроса. Прежний базовый класс печатал
 * такие узлы в `console.log` и продолжал обход, из-за чего `$filter=not (…)` возвращал всю
 * таблицу вместо подмножества.
 */

import { normalizeDialect } from '../dialect';
import { ODataInvalidQueryError, ODataUnsupportedError } from '../errors';
import { convertLiteral, literalToSql } from '../literal';
import { type Token, TokenType } from '../odataParser';
import type { ColumnTypeResolver, RelationSource, SqlDialect, SqlOptions } from '../types';
import { VISITOR_DEFAULTS } from './defaults';
import { dateTimeBound, resolveCast } from './edmCast';

/**
 * Строковые поля посетителя, в которые ветки обхода дописывают SQL.
 *
 * `'compute'` — не поле результата, а черновик: в него компилируется выражение `$compute`,
 * чтобы затем лечь в таблицу псевдонимов. Отдельная цель нужна потому, что выражение
 * компилируется теми же ветками обхода, что и `$filter`, а дописывать его в `where` нельзя.
 */
type TargetField = 'where' | 'select' | 'orderby' | 'compute';

/**
 * Контекст обхода AST, который передаётся сверху вниз по рекурсии `Visit`.
 *
 * @property target - в какое поле посетителя дописывать SQL. Устанавливается базовыми
 *   `VisitFilter` / `VisitSelect` / `VisitOrderBy`; по умолчанию `'where'`.
 * @property identifier - имя последнего разобранного идентификатора. Сохранено ради
 *   совместимости с базовым классом; логика этого класса на него больше не опирается.
 * @property literal - значение последнего разобранного литерала.
 */
interface Context {
  target: TargetField;
  identifier?: string;
  literal?: unknown;
}

/** Результат обхода одного операнда сравнения: сгенерированный SQL и признак литерала `null`. */
interface Operand {
  sql: string;
  isNull: boolean;
}

/**
 * Достаёт аргумент функции OData по номеру.
 *
 * Число аргументов проверяет уже грамматика парсера: `contains(name)` без второго
 * операнда до обхода не доходит, отвергается как `ODataParseError`. Но инвариант держится
 * на чужой библиотеке, а не на типах, поэтому проверка сделана явной — иначе отсутствующий
 * аргумент ушёл бы в `Visit(undefined)`, где базовый класс тихо ничего не сделает,
 * и на выходе получился бы синтаксически битый SQL.
 *
 * @throws {ODataUnsupportedError} если аргумента нет.
 */
function argumentAt(params: readonly Token[], index: number, method: string): Token {
  const param = params[index];

  if (!param) {
    throw new ODataUnsupportedError(
      `${method}() with ${params.length} argument(s)`,
      params.map((p) => p.raw).join(', ')
    );
  }

  return param;
}

export class TypeOrmVisitor {
  /** Список выбираемых колонок; `'*'` означает «`$select` не задан». */
  public select = '';

  /** Условие `WHERE`; `'1 = 1'` означает «`$filter` не задан». */
  public where = '';

  /** Выражение `ORDER BY`; `'1'` означает «`$orderby` не задан». */
  public orderby = '';

  /** Значение `$skip`; `undefined` — опция не задана. */
  public skip?: number;

  /** Значение `$top`; `undefined` — опция не задана. */
  public limit?: number;

  /** Значение `$count`. */
  public inlinecount = false;

  /** Имя связи для дочернего посетителя; у корня пустое. */
  public navigationProperty = '';

  /** Значения параметров запроса: `p0`, `p1`, … в порядке появления в SQL. */
  public parameters = new Map<string, unknown>();

  /**
   * Псевдонимы `$compute`: имя → скомпилированный SQL выражения.
   *
   * Именно таблица имён, а не новая ветка трансляции: `$compute=price mul qty as total` —
   * это уже умеющееся выражение под именем, и при разрешении идентификатора имя из этой
   * таблицы подставляется готовым SQL вместо ссылки на колонку.
   */
  public readonly computed = new Map<string, string>();

  /**
   * Псевдонимы `$compute`, названные в `$select`, — в порядке перечисления.
   *
   * В `select` они не попадают: там перечисляются колонки сущности, а вычисленное значение
   * колонкой не является и материализуется отдельно (см. `executeQueryByQueryBuilder`).
   */
  public readonly computedSelects: Array<{ name: string; sql: string }> = [];

  /**
   * Псевдонимы `$compute`, употреблённые в `$orderby`: имя → скомпилированный SQL.
   *
   * В `ORDER BY` уходит не само выражение, а SQL-псевдоним (см.
   * {@link TypeOrmVisitor.computedOrderByAlias}), поэтому выражение нужно ещё и добавить
   * в `SELECT`. Список для этого и ведётся; заполняет его слой выполнения.
   *
   * ПОЧЕМУ НЕ ВЫРАЖЕНИЕ ПРЯМО В `ORDER BY`. При пагинации вместе с соединением TypeORM
   * выбирает страницу в два приёма и разбирает каждое выражение сортировки как `алиас.колонка`.
   * Выражение `(Author.age * :p0)` он читает как алиас `(Author` и отказывается строить запрос:
   * `"(Author" alias was not found`. Ссылка на псевдоним из `SELECT` — та форма, которую
   * он понимает в обоих режимах.
   */
  public readonly computedOrderBy = new Map<string, string>();

  /**
   * Пути свойств, задействованные каждым выражением `$compute`.
   *
   * Отдельно от {@link TypeOrmVisitor.referencedFields}, где они лежат вперемешку с путями
   * из `$filter` и `$orderby`. Нужны слою выполнения: выражение над путём через связь
   * «ко многим» в `$select` считается по каждой связанной строке, и одного значения на
   * сущность у него не существует.
   */
  public readonly computedFields = new Map<string, string[]>();

  /**
   * Сквозной счётчик имён параметров.
   *
   * Общий на всё дерево: дочерние посетители забирают его перед обходом и возвращают после,
   * иначе `:p0` из вложенного `$filter` столкнулся бы с `:p0` корневого.
   */
  public parameterSeed = 0;

  /** Настройки генерации SQL, переданные в конструктор. */
  protected readonly options: SqlOptions;

  /** Корневой узел обхода: по нему определяется момент, когда пора проставить умолчания. */
  private ast?: Token;

  /**
   * Дочерние посетители — по одному на каждую связь, попавшую в запрос.
   * Создаются в {@link TypeOrmVisitor.VisitExpand} (для `$expand`) и в
   * {@link TypeOrmVisitor.resolveNavigationChain} (для путей `связь/поле` в фильтрах и сортировке).
   * Дальше дерево разворачивается в цепочку `leftJoin` в `processIncludes`.
   */
  public includes: TypeOrmVisitor[] = [];

  /**
   * SQL-алиас таблицы для этой ветки AST.
   *
   * Для корня — значение `options.alias`. Для связи — `<алиас родителя>_<имя связи>`
   * (`Author` → `Author_books` → `Author_books_reviews`). Схема даёт три свойства, на которые
   * опирается остальной код: алиас уникален в пределах запроса, не зависит от позиции текста
   * в исходной строке и вычислим по пути связи — поэтому `$expand` и `$filter` по одной и той же
   * связи приходят к одному и тому же имени.
   */
  public alias = '';

  /**
   * Пути свойств, которые запрос упомянул на этом уровне: `'name'`, `'books/reviews/score'`.
   *
   * Заполняется при обходе `$filter`, `$select` и `$orderby`. Нужно для проверки по белому
   * списку полей: после компиляции имена колонок уже вплавлены в строку SQL, и достать их
   * оттуда разбором было бы ненадёжно.
   *
   * Пути записываются относительно текущего уровня; полные пути от корня собирает
   * {@link TypeOrmVisitor.collectReferencedFields}.
   */
  public referencedFields: string[] = [];

  /**
   * Порядок разбора верхнеуровневых query options: сначала `$compute` (чтобы появились имена
   * псевдонимов), затем expand (чтобы появились JOIN-алиасы), затем filter и select.
   * Опции, не перечисленные здесь, получают indexOf -1 и оказываются «раньше» в сортировке
   * (то есть обрабатываются перед перечисленными).
   *
   * `$orderby` попал в список только ради `$compute`: без явной позиции он получал бы -1
   * и разбирался раньше псевдонимов, то есть `$orderby=total` не нашёл бы имени. Относительно
   * `$expand`, `$filter` и `$select` его место при этом не изменилось.
   */
  private queryOptionsSort = [
    TokenType.Compute,
    TokenType.OrderBy,
    TokenType.Expand,
    TokenType.Filter,
    TokenType.Select,
  ];

  /**
   * Признак «последним разобранным литералом был `null`».
   *
   * Нужен, чтобы отличить `field eq null` от `field eq :pN`. Через `context.literal` это
   * сделать нельзя: у операнда-идентификатора литерала нет вовсе, и `undefined` неотличим
   * от разобранного `null`.
   */
  private lastLiteralWasNull = false;

  /** Целевая СУБД: определяет, какие SQL-функции подставлять для функций OData. */
  private readonly dialect: SqlDialect;

  /** Черновик для компиляции одного выражения `$compute`; см. {@link TargetField}. */
  private computeBuffer = '';

  /**
   * Псевдонимы `$compute` внешнего уровня, видимые из тела лямбды.
   *
   * Парный к {@link TypeOrmVisitor.outerAlias}: имя без переменной лямбды относится
   * к внешней сущности, а значит и псевдоним искать нужно в её таблице имён.
   */
  private outerComputed?: ReadonlyMap<string, string>;

  /**
   * Имя переменной лямбды, если этот посетитель компилирует её тело (`books/any(b: …)` → `b`).
   *
   * Внутри тела путь, начинающийся с переменной, относится к связанной сущности, а любое
   * другое имя — к внешнему уровню: так требует спецификация (раздел 5.1.1.13), и так же
   * читается человеком.
   */
  private lambdaVariable = '';

  /** Алиас внешнего уровня — к нему относятся имена, не начинающиеся с переменной лямбды. */
  private outerAlias = '';

  /**
   * Как узнать тип свойства внешнего уровня из тела лямбды.
   *
   * Парный к {@link TypeOrmVisitor.outerAlias}: имя без переменной лямбды относится к внешней
   * сущности, а `options.resolveColumnType` у этого посетителя переведён на связанную.
   * Без второй функции `cast(pages, Edm.String)` внутри `books/any(b: …)` спрашивал бы тип
   * колонки не у той сущности.
   */
  private outerResolveColumnType?: ColumnTypeResolver;

  /**
   * Как записать колонку связанной сущности внутри тела лямбды.
   *
   * Своими силами посетитель этого не может: во внешнем запросе имя свойства в имя колонки
   * превращает TypeORM, но алиас подзапроса ему неизвестен. Функцию отдаёт резолвер связей —
   * у него есть метаданные.
   */
  private lambdaColumn?: (property: string) => string;

  /**
   * Пути связей, пройденные лямбда-операторами.
   *
   * Отдельно от `includes`, потому что лямбда не создаёт JOIN — она разворачивается в `EXISTS`.
   * Но для белого списка `allowedExpands` разницы нет: связь в запросе задействована,
   * и проверка обязана её увидеть.
   */
  private readonly lambdaRelations: string[] = [];

  constructor(options: SqlOptions) {
    // Параметры вместо инлайна литералов — умолчание: инлайн допустим только там,
    // где SQL собирают руками, и включается явно.
    this.options = { ...options, useParameters: options.useParameters !== false };
    this.alias = options.alias || this.alias;
    this.dialect = normalizeDialect(options.dialect);
  }

  /**
   * Обход узла AST с отказом вместо тихого пропуска.
   *
   * Базовая реализация при отсутствии метода `Visit<Тип>` печатает предупреждение в `console.log`
   * и идёт дальше. Для фильтра это недопустимо: потерянное условие означает, что клиент получит
   * больше данных, чем запрашивал, и не узнает об этом. Поэтому здесь неизвестный узел —
   * всегда ошибка.
   *
   * @throws {ODataUnsupportedError} для узла, который библиотека не умеет транслировать.
   */
  public Visit(node: Token, context: Context = { target: 'where' }): this {
    this.ast = this.ast ?? node;

    if (node) {
      const handlerName = `Visit${node.type}` as keyof this;
      const handler = this[handlerName];

      if (typeof handler !== 'function') {
        throw new ODataUnsupportedError(node.type, node.raw);
      }

      (handler as (node: Token, context: Context) => void).call(this, node, context);
    }

    // Умолчания проставляются на выходе из корневого узла: вызывающий код читает их
    // как признак «опция не задана».
    if (node === this.ast) {
      this.applyDefaults();
    }

    return this;
  }

  /**
   * Собирает полный SQL SELECT: список полей, WHERE, ORDER BY и, при необходимости,
   * пагинацию в форме `OFFSET … ROWS FETCH NEXT … ROWS ONLY`.
   *
   * В сценарии с TypeORM этот метод не используется — QueryBuilder собирает SQL сам из
   * `select` / `where` / `parameters`. `from()` нужен для «сырого» сценария (`createQuery` +
   * драйвер БД; рецепт с `pg` — в `docs/recipes.md`, раздел «Без TypeORM: только компиляция в SQL»).
   *
   * @param table - имя таблицы; подставляется в SQL как есть, без экранирования, поэтому
   *   передавать сюда пользовательский ввод нельзя.
   */
  public from(table: string) {
    let sql = `SELECT ${this.select} FROM ${table} WHERE ${this.where} ORDER BY ${this.orderby}`;

    if (typeof this.skip == 'number') {
      sql += ` OFFSET ${this.skip} ROWS`;
    }

    if (typeof this.limit == 'number') {
      if (typeof this.skip != 'number') {
        sql += ' OFFSET 0 ROWS';
      }

      sql += ` FETCH NEXT ${this.limit} ROWS ONLY`;
    }

    return sql;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Работа с целевым фрагментом SQL
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Все пути свойств, упомянутые запросом, — от корня и вглубь по связям.
   *
   * @param prefix - путь до текущего уровня; при внешнем вызове не задаётся.
   * @returns пути вида `'name'`, `'books/title'`, `'books/reviews/score'` без повторов.
   *
   * @example
   * const compiled = createQuery('$select=id&$expand=books($select=title)', { alias: 'A' });
   *
   * compiled.collectReferencedFields(); // ['id', 'books/title']
   */
  public collectReferencedFields(prefix = ''): string[] {
    const result: string[] = [];

    for (const field of this.referencedFields) {
      const path = prefix ? `${prefix}/${field}` : field;

      if (!result.includes(path)) {
        result.push(path);
      }
    }

    for (const include of this.includes) {
      const nested = prefix
        ? `${prefix}/${include.navigationProperty}`
        : include.navigationProperty;

      for (const path of include.collectReferencedFields(nested)) {
        if (!result.includes(path)) {
          result.push(path);
        }
      }
    }

    return result;
  }

  /**
   * Имена всех связей, задействованных запросом, на всех уровнях вложенности.
   *
   * Включает связи из `$expand`, «виртуальные» — созданные путями `связь/поле` в фильтрах
   * и сортировке, — и пройденные лямбда-операторами: JOIN они не создают, но связь
   * задействуют, и белый список обязан это видеть.
   *
   * @returns имена связей без путей: для `$expand=books($expand=reviews)` — `['books', 'reviews']`.
   */
  public collectNavigationProperties(): string[] {
    const result: string[] = [...this.lambdaRelations];

    for (const include of this.includes) {
      if (!result.includes(include.navigationProperty)) {
        result.push(include.navigationProperty);
      }

      for (const nested of include.collectNavigationProperties()) {
        if (!result.includes(nested)) {
          result.push(nested);
        }
      }
    }

    return result;
  }

  /**
   * Приписывает к имени колонки алиас текущего уровня.
   *
   * Пустой алиас — легитимный режим для «сырого» сценария (`createFilter(expr, { alias: '' })`,
   * запрос к одной таблице без алиаса). Тогда префикс не добавляется вовсе: раньше в этом
   * случае получалось `.Id = :p0` с ведущей точкой, то есть заведомо невалидный SQL —
   * ровно в том сценарии, ради которого `createFilter` и существует. См. `docs/audit.md`,
   * дефект A-13.
   */
  private qualify(name: string): string {
    return this.alias ? `${this.alias}.${name}` : name;
  }

  /**
   * SQL-псевдоним, под которым вычисленное значение попадает в `SELECT` ради сортировки.
   *
   * Имя уровня в префиксе разводит одноимённые псевдонимы разных областей: `$compute=x as d`
   * на корне и такой же внутри `$expand` дали бы в одном `SELECT` два `d`.
   */
  public computedOrderByAlias(name: string): string {
    return this.alias ? `${this.alias}_${name}` : name;
  }

  /** Регистрирует упомянутый путь свойства; повторы отбрасываются. */
  private trackField(path: string): void {
    if (!this.referencedFields.includes(path)) {
      this.referencedFields.push(path);
    }
  }

  /**
   * Переводит резолвер типов на уровень вглубь: путь дополняется префиксом связи.
   *
   * @param prefix - путь связей от текущего уровня до нового.
   * @returns резолвер для дочернего посетителя либо `undefined`, если своего резолвера нет.
   */
  private rebaseColumnTypeResolver(prefix: readonly string[]): ColumnTypeResolver | undefined {
    const resolve = this.options.resolveColumnType;

    if (!resolve) {
      return undefined;
    }

    return (path) => resolve([...prefix, path].join('/'));
  }

  /**
   * Тип EDM свойства по пути, записанному так, как он выглядит в этом фрагменте запроса.
   *
   * Внутри тела лямбды действует то же правило, что и в
   * {@link TypeOrmVisitor.visitInsideLambda}: путь с переменной относится к связанной
   * сущности, любой другой — к внешней. Отсюда и две функции разрешения.
   *
   * @returns имя типа EDM либо `undefined`, если тип неизвестен: резолвер не передан,
   *   свойства нет либо путь ведёт через связь внутри лямбды.
   */
  private resolveTypeOfPath(path: string): string | undefined {
    if (!this.lambdaVariable) {
      return this.options.resolveColumnType?.(path);
    }

    const segments = path.split('/');

    if (segments[0] !== this.lambdaVariable) {
      return this.outerResolveColumnType?.(path);
    }

    return segments.length === 2
      ? this.options.resolveColumnType?.(segments[1] as string)
      : undefined;
  }

  /**
   * Тип EDM операнда: колонки или литерала.
   *
   * Выражения (арифметика, вызовы функций) типа не имеют: выводить его пришлось бы правилами
   * вроде «`INTEGER` плюс `INTEGER` — снова `INTEGER`», которые у СУБД расходятся. Такой
   * операнд остаётся без типа, и приведение над ним отвергается — см.
   * {@link TypeOrmVisitor.visitCast}.
   */
  private inferEdmType(node: Token): string | undefined {
    switch (node.type) {
      case TokenType.Literal:
        // `null` не тип, а отсутствие значения: приводить его не к чему.
        return node.value === 'null' ? undefined : (node.value as string);

      case TokenType.ODataIdentifier:
        return this.resolveTypeOfPath(node.value.name as string);

      case TokenType.PropertyPathExpression:
        return this.resolveTypeOfPath(node.raw);

      default:
        return undefined;
    }
  }

  /** Дописывает SQL в поле, указанное `context.target`. */
  private append(context: Context, sql: string): void {
    this.write(context, this.read(context) + sql);
  }

  /** Читает текущее содержимое поля, указанного `context.target`. */
  private read(context: Context): string {
    switch (context.target) {
      case 'select':
        return this.select;
      case 'orderby':
        return this.orderby;
      case 'compute':
        return this.computeBuffer;
      default:
        return this.where;
    }
  }

  /** Полностью заменяет содержимое поля, указанного `context.target`. */
  private write(context: Context, sql: string): void {
    switch (context.target) {
      case 'select':
        this.select = sql;
        break;
      case 'orderby':
        this.orderby = sql;
        break;
      case 'compute':
        this.computeBuffer = sql;
        break;
      default:
        this.where = sql;
        break;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Query options
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Обработка узла с несколькими query options: сначала сортируем дочерние токены в нужном порядке,
   * затем рекурсивно делегируем в `Visit`.
   */
  protected VisitQueryOptions(node: Token, context: Context) {
    node.value.options
      .sort(
        (a: Token, b: Token) =>
          this.queryOptionsSort.indexOf(a.type) - this.queryOptionsSort.indexOf(b.type)
      )
      .forEach((option: Token) => this.Visit(option, context));
  }

  /** `$filter`: всё выражение пишется в `where`. */
  protected VisitFilter(node: Token, context: Context) {
    context.target = 'where';

    this.Visit(node.value, context);
  }

  /**
   * `$select`: список полей.
   *
   * Разделитель между элементами добавляет сам {@link TypeOrmVisitor.VisitSelectItem} —
   * раньше это делали оба места сразу, и в списке появлялись двойные запятые (задача R-29).
   */
  protected VisitSelect(node: Token, context: Context) {
    context.target = 'select';

    node.value.items.forEach((item: Token) => this.Visit(item, context));
  }

  /**
   * `$compute`: список выражений с именами.
   *
   * Разбирается раньше `$filter`, `$orderby` и `$select` — иначе имя псевдонима не нашлось бы
   * при разрешении идентификатора (см. {@link TypeOrmVisitor.queryOptionsSort}).
   */
  protected VisitCompute(node: Token, context: Context) {
    node.value.items.forEach((item: Token) => this.Visit(item, context));
  }

  /**
   * Один элемент `$compute`: `<выражение> as <имя>`.
   *
   * Выражение компилируется сразу и целиком, а результат кладётся в таблицу имён. Отложить
   * компиляцию до первого употребления нельзя: `$compute` может остаться неиспользованным,
   * и тогда ошибка в его выражении прошла бы незамеченной, а поля внутри — мимо белого списка.
   *
   * ПРО СТОЛКНОВЕНИЕ ИМЁН. Совпадение с именем свойства сущности — ошибка по спецификации,
   * а не переопределение: молча выигранное имя означало бы фильтр не по той колонке. Ответить
   * на вопрос «есть ли такое свойство» умеет только `resolveColumnType` (R-44); без него
   * (прямой вызов `createFilter` без метаданных) проверка не выполняется, как и всё остальное,
   * что опирается на метаданные.
   *
   * @throws {ODataInvalidQueryError} имя занято свойством сущности либо другим псевдонимом.
   */
  protected VisitComputeItem(node: Token, context: Context) {
    const name = node.value.name as string;

    if (this.computed.has(name)) {
      throw new ODataInvalidQueryError('$compute', `duplicate name: ${name}`);
    }

    if (this.options.resolveColumnType?.(name) !== undefined) {
      throw new ODataInvalidQueryError(
        '$compute',
        `name collides with a property of the entity: ${name}`
      );
    }

    // Поля, упомянутые именно этим выражением: то, что появилось в referencedFields за время
    // его обхода. Общий список ведётся сквозным, поэтому запоминается его длина до обхода.
    const fieldsBefore = this.referencedFields.length;
    const buffer = this.computeBuffer;

    this.computeBuffer = '';

    this.Visit(node.value.expr, { ...context, target: 'compute' });

    const sql = this.computeBuffer;

    this.computeBuffer = buffer;

    this.computed.set(name, sql);
    this.computedFields.set(name, this.referencedFields.slice(fieldsBefore));
  }

  /** `$orderby`: список выражений с направлением. */
  protected VisitOrderBy(node: Token, context: Context) {
    context.target = 'orderby';

    node.value.items.forEach((item: Token, index: number) => {
      if (index > 0) {
        this.orderby += ', ';
      }

      this.Visit(item, context);
    });
  }

  /** Один элемент `$orderby`: выражение и направление. */
  protected VisitOrderByItem(node: Token, context: Context) {
    this.Visit(node.value.expr, context);

    this.orderby += node.value.direction > 0 ? ' ASC' : ' DESC';
  }

  /** `$top`. Значение проверяет вызывающий код: отрицательное — ошибка клиента, а не парсера. */
  protected VisitTop(node: Token) {
    this.limit = Number(node.value.raw);
  }

  /** `$skip`. */
  protected VisitSkip(node: Token) {
    this.skip = Number(node.value.raw);
  }

  /** `$count`. Форму ответа по нему выбирает `executeQuery`, а не посетитель. */
  protected VisitInlineCount(node: Token) {
    this.inlinecount = convertLiteral(node.value.value, node.value.raw) === true;
  }

  /** Один элемент `$expand`: имя связи и вложенные опции. */
  protected VisitExpandItem(node: Token, context: Context) {
    this.Visit(node.value.path, context);

    if (node.value.options) {
      node.value.options.forEach((option: Token) => this.Visit(option, context));
    }
  }

  /** Имя связи внутри `$expand`. */
  protected VisitExpandPath(node: Token) {
    this.navigationProperty = node.raw;
  }

  /** Логическое `and`. */
  protected VisitAndExpression(node: Token, context: Context) {
    this.Visit(node.value.left, context);
    this.append(context, ' AND ');
    this.Visit(node.value.right, context);
  }

  /** Логическое `or`. */
  protected VisitOrExpression(node: Token, context: Context) {
    this.Visit(node.value.left, context);
    this.append(context, ' OR ');
    this.Visit(node.value.right, context);
  }

  /**
   * Скобочная группа логического выражения.
   *
   * Отличается от {@link TypeOrmVisitor.VisitParenExpression} только тем, что группирует:
   * там арифметика, здесь логика. Обе пишут скобки — группировку, заданную запросом,
   * нельзя терять по дороге в SQL.
   */
  protected VisitBoolParenExpression(node: Token, context: Context) {
    this.append(context, '(');
    this.Visit(node.value, context);
    this.append(context, ')');
  }

  /**
   * `$expand`: для каждой связи находим или создаём вложенный `TypeOrmVisitor`, обходящий свою
   * ветку AST независимо (свои `select` / `where` / `orderby`).
   *
   * Поиск по `navigationProperty` — та же операция, что и в {@link TypeOrmVisitor.resolveNavigationChain},
   * поэтому `$expand=books` и `$filter=books/title eq '…'` работают с одним и тем же include
   * и одним и тем же JOIN. Повторный `$expand` той же связи (`$expand=books($select=id),books($select=title)`)
   * тоже попадает в существующий посетитель и даёт один JOIN с объединённым списком колонок.
   *
   * `parameterSeed` передаётся в дочерний посетитель и забирается обратно, чтобы сквозная
   * нумерация `:p0, :p1, …` не пересекалась между корнем и вложенными ветками.
   */
  protected VisitExpand(node: Token) {
    node.value.items.forEach((item: Token) => {
      const navigationProperty = item.value.path.raw;

      const visitor =
        this.includes.find((v) => v.navigationProperty === navigationProperty) ??
        this.createInclude(navigationProperty);

      // Служебные значения ('1 = 1' / '1') сбрасываются, иначе разбор вложенных опций
      // дописал бы SQL к ним: `$expand=books($orderby=id)` дал бы '1Author_books.id'.
      // Накопленный $select при этом сохраняется — так повторный $expand одной связи
      // объединяется в один JOIN с общим списком колонок.
      if (visitor.where === VISITOR_DEFAULTS.where) {
        visitor.where = '';
      }

      if (visitor.orderby === VISITOR_DEFAULTS.orderby) {
        visitor.orderby = '';
      }

      visitor.parameterSeed = this.parameterSeed;

      visitor.Visit(item);

      this.parameterSeed = visitor.parameterSeed;

      // Базовый Visit подставляет умолчания только на самом верхнем узле своего обхода,
      // поэтому при повторном заходе они не применяются. Проставляем явно.
      visitor.applyDefaults();
    });
  }

  /**
   * Возвращает «пустым» полям значения по умолчанию, принятые в `odata-v4-sql`.
   *
   * Именно эти значения вызывающий код (`executeQueryByQueryBuilder`, `processIncludes`)
   * читает как признак «опция не задана», поэтому пустая строка вместо них недопустима.
   */
  private applyDefaults(): void {
    if (!this.select) {
      this.select = VISITOR_DEFAULTS.select;
    }

    if (!this.where) {
      this.where = VISITOR_DEFAULTS.where;
    }

    if (!this.orderby) {
      this.orderby = VISITOR_DEFAULTS.orderby;
    }
  }

  /**
   * Один элемент `$select`.
   *
   * Для пути `Связь/Поле` берётся реальный JOIN-алиас связи из соответствующего include;
   * если include не найден, связь всё равно резолвится (создаётся виртуальный JOIN), поэтому
   * `$select=books/title` работает и без явного `$expand`.
   */
  protected VisitSelectItem(node: Token, context: Context) {
    const computed = this.computed.get(node.raw);

    if (computed !== undefined) {
      // Вычисленное значение колонкой сущности не является: в `select` ему места нет,
      // материализует его слой выполнения отдельным `addSelect` (R-48).
      if (!this.computedSelects.some((item) => item.name === node.raw)) {
        this.computedSelects.push({ name: node.raw, sql: computed });
      }

      return;
    }

    if (this.select !== '' && !this.select.trim().endsWith(',')) {
      this.select += ', ';
    }

    const segments = node.raw.split('/');

    this.trackField(node.raw);

    if (segments.length > 1) {
      const field = segments.pop() as string;
      const alias = this.resolveNavigationChain(segments);

      this.select += `${alias}.${field}`;

      return;
    }

    this.select += this.qualify(node.raw);
    context.identifier = node.raw;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Пути свойств и связи
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Цепочка свойств в выражении: `author/name`, `books/reviews/score`.
   *
   * Весь путь берётся из `node.raw` целиком, а не собирается по кусочкам при рекурсивном обходе.
   * Так короче и, главное, надёжнее: раньше алиас связи получался ретроактивной правкой уже
   * записанной строки регулярным выражением, и любое расхождение в именовании давало ссылку
   * на несуществующий алиас (дефект A-02).
   *
   * Для каждого сегмента-связи гарантируется наличие include-посетителя; последний сегмент —
   * имя колонки, оно префиксуется алиасом самой глубокой связи.
   */
  protected VisitPropertyPathExpression(node: Token, context: Context) {
    if (this.lambdaVariable) {
      this.visitInsideLambda(node, context);

      return;
    }

    if (node.value.current && node.value.next) {
      const segments = node.raw.split('/');
      const field = segments.pop() as string;
      const alias = this.resolveNavigationChain(segments);

      this.trackField(node.raw);

      this.append(context, `${alias}.${field}`);
      context.identifier = field;

      return;
    }

    this.Visit(node.value, context);
  }

  /**
   * Путь свойства внутри тела лямбды.
   *
   * Путь, начинающийся с переменной (`b/pages`), относится к связанной сущности; любой
   * другой — к внешнему уровню (`books/any(b: b/pages gt pages)` сравнивает страницы книги
   * со страницами внешней сущности).
   *
   * @throws {ODataUnsupportedError} для пути через связь внутри тела (`b/author/name`):
   *   он потребовал бы ещё одного соединения внутри подзапроса. Тот же смысл выражается
   *   вложенной лямбдой, которая поддержана.
   */
  private visitInsideLambda(node: Token, context: Context) {
    const segments = node.raw.split('/');

    if (segments[0] !== this.lambdaVariable) {
      const computed = this.outerComputed?.get(node.raw);

      if (computed !== undefined) {
        // Псевдоним внешнего уровня. Его SQL ссылается на внешний алиас, и внутри
        // коррелированного подзапроса такая ссылка законна — на ней же держится
        // само сравнение с внешней сущностью.
        this.append(context, computed);
        context.identifier = node.raw;

        return;
      }

      // Имя внешнего уровня: и трекинг, и префикс относятся к нему.
      this.trackField(node.raw);
      this.append(context, this.outerAlias ? `${this.outerAlias}.${node.raw}` : node.raw);
      context.identifier = node.raw;

      return;
    }

    if (segments.length !== 2) {
      throw new ODataUnsupportedError('property path through a relation inside a lambda', node.raw);
    }

    const field = segments[1] as string;

    this.trackField(field);
    this.append(context, this.lambdaColumn ? this.lambdaColumn(field) : this.qualify(field));
    context.identifier = field;
  }

  /**
   * Гарантирует наличие include-посетителей для всей цепочки связей и возвращает алиас последней.
   *
   * Для `['books', 'reviews']` при корневом алиасе `Author` создаст (или найдёт) посетитель
   * `books` с алиасом `Author_books`, внутри него — `reviews` с алиасом `Author_books_reviews`,
   * и вернёт `Author_books_reviews`.
   *
   * Уже существующие include (например созданные `$expand`) переиспользуются как есть —
   * их `select` не затирается, поэтому явно запрошенные колонки связи не теряются.
   *
   * @param navigationPath - имена связей от текущего уровня вглубь.
   * @returns SQL-алиас последней связи в цепочке.
   */
  private resolveNavigationChain(navigationPath: string[]): string {
    // reduce, а не цикл с локальной переменной: так текущий уровень передаётся по цепочке
    // без промежуточного алиаса на `this`.
    const deepest = navigationPath.reduce<TypeOrmVisitor>(
      (owner, navigationProperty) =>
        owner.includes.find((v) => v.navigationProperty === navigationProperty) ??
        owner.createInclude(navigationProperty),
      this
    );

    return deepest.alias;
  }

  /**
   * Создаёт дочерний посетитель для связи и регистрирует его в `includes`.
   *
   * Новый посетитель заводится «пустым»: `select = ''` означает «связь нужна только для JOIN,
   * колонки не выбирать», `where = '1 = 1'` — «дополнительного условия на JOIN нет».
   * Если позже до этой связи доберётся `$expand`, он переопределит оба значения.
   */
  private createInclude(navigationProperty: string): TypeOrmVisitor {
    const visitor = new TypeOrmVisitor({
      ...this.options,
      // Пустой корневой алиас не должен давать ведущее подчёркивание в имени JOIN-алиаса.
      alias: this.alias ? `${this.alias}_${navigationProperty}` : navigationProperty,
      // Пути внутри связи отсчитываются от неё самой, а резолвер знает пути от корня —
      // поэтому он передаётся вглубь со сдвигом на имя связи. Так же устроен резолвер
      // связей: слой выполнения отдаёт корневой, а вложенность добавляет компилятор.
      resolveColumnType: this.rebaseColumnTypeResolver([navigationProperty]),
    });

    visitor.parameterSeed = this.parameterSeed;
    visitor.navigationProperty = navigationProperty;
    visitor.select = '';
    visitor.where = VISITOR_DEFAULTS.where;

    // orderby намеренно остаётся пустым, а не '1': если до этой связи доберётся
    // `$expand=...($orderby=…)`, разбор допишет сортировку к содержимому поля.

    this.includes.push(visitor);

    return visitor;
  }

  /**
   * Одиночное имя колонки: префиксуется алиасом текущего уровня.
   *
   * Пути `связь/поле` сюда не доходят — их целиком разбирает
   * {@link TypeOrmVisitor.VisitPropertyPathExpression}.
   */
  protected VisitODataIdentifier(node: Token, context: Context) {
    const computed = this.computed.get(node.value.name);

    if (computed !== undefined) {
      // Псевдоним `$compute` — не колонка, а готовый SQL. В `referencedFields` он не попадает
      // намеренно: белый список обязан проверять пути внутри выражения, а не имя, которое
      // клиент придумал сам, — иначе `$compute` стал бы обходом проверки из R-11. Пути внутри
      // уже записаны при компиляции выражения.
      //
      // В сортировке вместо выражения пишется SQL-псевдоним: выражение в `ORDER BY` ломает
      // двухшаговую пагинацию TypeORM — см. {@link TypeOrmVisitor.computedOrderBy}.
      if (context.target === 'orderby') {
        this.computedOrderBy.set(node.value.name, computed);
        this.append(context, this.computedOrderByAlias(node.value.name));
      } else {
        this.append(context, computed);
      }

      context.identifier = node.value.name;

      return;
    }

    this.trackField(node.value.name);

    this.append(context, this.qualify(node.value.name));

    context.identifier = node.value.name;
  }

  /**
   * Имя типа вне приведения: `name eq Edm.String`.
   *
   * Грамматика допускает имя типа в любой позиции аргумента, но осмысленно оно ровно
   * в одной — втором аргументе `cast`, где его разбирает {@link TypeOrmVisitor.visitCast},
   * не доходя до этого метода. Везде остальное имя типа — не значение, и сравнивать с ним
   * нечего; отдельный метод нужен, чтобы отказ назвал причину, а не тип узла AST.
   *
   * @throws {ODataUnsupportedError} всегда.
   */
  protected VisitTypeReference(node: Token): never {
    throw new ODataUnsupportedError(`type name "${node.value.name}" outside of cast()`, node.raw);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Логические операторы
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Логическое отрицание `not`.
   *
   * Скобки ставятся всегда: приоритет `NOT` в SQL выше, чем у `AND` / `OR`, и без них
   * `not (a eq 1) and b eq 2` превратилось бы в `NOT a = :p0 AND b = :p1`, то есть
   * отрицание применилось бы только к первому условию. Лишняя пара скобок вокруг уже
   * скобочного выражения безвредна.
   */
  protected VisitNotExpression(node: Token, context: Context) {
    this.append(context, 'NOT (');
    this.Visit(node.value, context);
    this.append(context, ')');
  }

  /**
   * Скобочная группа в арифметическом выражении: `(age add 4) mul 2`.
   *
   * Отличается от {@link TypeOrmVisitor.VisitBoolParenExpression} тем, что группирует
   * не булево подвыражение, а арифметическое. Какой из двух узлов построить, решает парсер
   * по типу содержимого скобок.
   */
  protected VisitParenExpression(node: Token, context: Context) {
    this.append(context, '(');
    this.Visit(node.value, context);
    this.append(context, ')');
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Арифметика
  // ───────────────────────────────────────────────────────────────────────────

  /** Сложение `add`. */
  protected VisitAddExpression(node: Token, context: Context) {
    this.visitArithmetic(node, context, '+');
  }

  /** Вычитание `sub`. */
  protected VisitSubExpression(node: Token, context: Context) {
    this.visitArithmetic(node, context, '-');
  }

  /** Умножение `mul`. */
  protected VisitMulExpression(node: Token, context: Context) {
    this.visitArithmetic(node, context, '*');
  }

  /** Деление `div`. */
  protected VisitDivExpression(node: Token, context: Context) {
    this.visitArithmetic(node, context, '/');
  }

  /** Остаток от деления `mod`. */
  protected VisitModExpression(node: Token, context: Context) {
    this.visitArithmetic(node, context, '%');
  }

  /** Унарный минус: `-age gt -100`. */
  protected VisitNegateExpression(node: Token, context: Context) {
    this.append(context, '-');
    this.Visit(node.value, context);
  }

  /**
   * Общая форма бинарного арифметического оператора.
   *
   * Скобки вокруг всего выражения ставятся, чтобы приоритет операций не зависел от того,
   * в какое окружение попадёт фрагмент. OData уже задала группировку структурой AST —
   * скобки просто переносят её в SQL без потерь.
   */
  private visitArithmetic(node: Token, context: Context, sqlOperator: string) {
    this.append(context, '(');
    this.Visit(node.value.left, context);
    this.append(context, ` ${sqlOperator} `);
    this.Visit(node.value.right, context);
    this.append(context, ')');
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Сравнения
  // ───────────────────────────────────────────────────────────────────────────

  /** Равенство `eq`; сравнение с `null` превращается в `IS NULL`. */
  protected VisitEqualsExpression(node: Token, context: Context) {
    this.visitComparison(node, context, '=', 'IS NULL', true);
  }

  /** Неравенство `ne`; сравнение с `null` превращается в `IS NOT NULL`. */
  protected VisitNotEqualsExpression(node: Token, context: Context) {
    this.visitComparison(node, context, '<>', 'IS NOT NULL', false);
  }

  /** Строго меньше `lt`. */
  protected VisitLesserThanExpression(node: Token, context: Context) {
    this.visitComparison(node, context, '<');
  }

  /** Меньше либо равно `le`. */
  protected VisitLesserOrEqualsExpression(node: Token, context: Context) {
    this.visitComparison(node, context, '<=');
  }

  /** Строго больше `gt`. */
  protected VisitGreaterThanExpression(node: Token, context: Context) {
    this.visitComparison(node, context, '>');
  }

  /** Больше либо равно `ge`. */
  protected VisitGreaterOrEqualsExpression(node: Token, context: Context) {
    this.visitComparison(node, context, '>=');
  }

  /**
   * Общая форма бинарного сравнения с поддержкой `null`.
   *
   * SQL не умеет сравнивать с NULL через `=` — нужно `IS NULL`. Узнать, что операнд окажется
   * литералом `null`, до его обхода нельзя, поэтому применяется пост-обработка: запоминаются
   * смещения в целевой строке, и если ровно одна сторона оказалась `null`, всё выражение
   * переписывается в `<другая сторона> IS [NOT] NULL`.
   *
   * Работа со смещениями, а не с регулярными выражениями по хвосту строки — принципиальный
   * момент: прошлая реализация подставляла имя идентификатора в `RegExp` без экранирования
   * и не срабатывала, когда `null` стоял слева (`null eq bio`).
   *
   * @param sqlOperator - оператор SQL для обычного случая.
   * @param nullOperator - чем заменить выражение, если одна из сторон `null`.
   * @param bothNullResult - результат вырожденного `null eq null` / `null ne null`.
   */
  private visitComparison(
    node: Token,
    context: Context,
    sqlOperator: string,
    nullOperator?: string,
    bothNullResult?: boolean
  ) {
    const startIndex = this.read(context).length;

    const left = this.visitOperand(node.value.left, context, startIndex);

    this.append(context, ` ${sqlOperator} `);

    const rightIndex = this.read(context).length;
    const right = this.visitOperand(node.value.right, context, rightIndex);

    // Обычное сравнение: обе стороны — не null, переписывать нечего.
    if (!nullOperator || (!left.isNull && !right.isNull)) {
      return;
    }

    const prefix = this.read(context).slice(0, startIndex);

    if (left.isNull && right.isNull) {
      // Вырожденный случай `null eq null`: значение выражения известно статически.
      this.write(context, prefix + (bothNullResult ? '1 = 1' : '1 = 0'));

      return;
    }

    const operand = left.isNull ? right.sql : left.sql;

    this.write(context, `${prefix}${operand} ${nullOperator}`);
  }

  /**
   * Обходит один операнд и возвращает сгенерированный им SQL вместе с признаком литерала `null`.
   *
   * @param fromIndex - длина целевой строки до обхода; всё, что появилось после, и есть SQL операнда.
   */
  private visitOperand(node: Token, context: Context, fromIndex: number): Operand {
    this.lastLiteralWasNull = false;

    this.Visit(node, context);

    return {
      sql: this.read(context).slice(fromIndex),
      isNull: this.lastLiteralWasNull,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Множества и коллекции
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Оператор `in`: `age in (30, 40, 50)`.
   *
   * Значения раскладываются по параметрам, как и любые другие литералы, — список
   * из запроса в текст SQL не попадает.
   */
  protected VisitInExpression(node: Token, context: Context) {
    const values: Token[] = node.value.values ?? [];

    // Пустой список не совпадает ни с чем, а `IN ()` — синтаксическая ошибка почти везде.
    if (values.length === 0) {
      this.append(context, '1 = 0');

      return;
    }

    this.Visit(node.value.left, context);
    this.append(context, ' IN (');

    values.forEach((value, index) => {
      if (index > 0) {
        this.append(context, ', ');
      }

      this.Visit(value, context);
    });

    this.append(context, ')');
  }

  /**
   * Лямбда-операторы `any` и `all`.
   *
   * Оба разворачиваются в коррелированный подзапрос, а не в соединение: `JOIN` с коллекцией
   * размножил бы корневые строки, и `$top` начал бы возвращать не то число записей.
   *
   * ```sql
   * -- books/any(b: b/pages gt 100)
   * EXISTS (SELECT 1 FROM "book" "Author_books_b"
   *          WHERE "Author_books_b"."author_id" = "Author"."id" AND ("Author_books_b"."pages" > :p0))
   *
   * -- books/all(b: b/pages gt 100)
   * NOT EXISTS (SELECT 1 FROM "book" "Author_books_b"
   *              WHERE "Author_books_b"."author_id" = "Author"."id" AND NOT ("Author_books_b"."pages" > :p0))
   * ```
   *
   * `all` через отрицание `any` даёт и правильный ответ на пустой коллекции: «все элементы
   * удовлетворяют условию» истинно, когда элементов нет вовсе.
   *
   * ПРО NULL. Если условие для строки не определено (сравнение с `NULL`), такая строка
   * не попадает ни в `EXISTS`, ни в `NOT EXISTS` — то есть для `all` считается подходящей.
   * Это поведение трёхзначной логики SQL, и переопределять его библиотека не берётся:
   * запрос, написанный руками, повёл бы себя так же.
   *
   * @throws {ODataUnsupportedError} если вызывающий код не передал способ разрешить связь.
   *   Так бывает при прямом вызове `createFilter` без метаданных: имя таблицы взять неоткуда.
   */
  protected VisitLambdaExpression(node: Token, context: Context) {
    // Внутри тела лямбды путь начинается с её переменной: `b/reviews/any(…)` считает связи
    // от книги, а не от автора, и первый сегмент к пути связей не относится.
    const navigation: string[] = this.lambdaVariable
      ? (node.value.navigation as string[]).slice(1)
      : node.value.navigation;
    const operator: 'any' | 'all' = node.value.operator;
    const variable: string = node.value.variable;
    const predicate: Token | undefined = node.value.predicate;

    const resolve = this.options.resolveRelation;

    if (!resolve) {
      throw new ODataUnsupportedError('lambda operators (any/all)', node.raw);
    }

    // Алиас уникален внутри своего подзапроса, а подзапросы друг друга не видят —
    // поэтому достаточно имени переменной и пути связи.
    const childAlias = [this.alias, ...navigation, variable].filter(Boolean).join('_');
    const source = resolve(navigation, this.alias, childAlias);

    if (!source) {
      throw new ODataUnsupportedError('lambda over an unknown navigation property', node.raw);
    }

    for (const name of navigation) {
      if (!this.lambdaRelations.includes(name)) {
        this.lambdaRelations.push(name);
      }
    }

    const conditions = [source.where];

    if (predicate) {
      const body = this.compileLambdaBody(predicate, childAlias, variable, source, navigation);

      conditions.push(operator === 'all' ? `NOT (${body})` : `(${body})`);
    }

    const exists = operator === 'all' ? 'NOT EXISTS' : 'EXISTS';

    this.append(
      context,
      `${exists} (SELECT 1 FROM ${source.from} WHERE ${conditions.join(' AND ')})`
    );
  }

  /**
   * Компилирует тело лямбды отдельным посетителем.
   *
   * Отдельный посетитель нужен, потому что внутри тела другой алиас и другая сущность.
   * Счётчик параметров при этом общий: `:p0` из тела и `:p0` снаружи столкнулись бы в одном
   * запросе. Упомянутые в теле поля возвращаются наверх с префиксом пути — иначе белый список
   * `allowedFields` не увидел бы обращения внутри лямбды.
   */
  private compileLambdaBody(
    predicate: Token,
    childAlias: string,
    variable: string,
    source: RelationSource,
    navigation: readonly string[]
  ): string {
    const inner = new TypeOrmVisitor({
      ...this.options,
      alias: childAlias,
      // Вложенные лямбды считают связи уже от целевой сущности.
      resolveRelation: source.resolveRelation,
      // И типы колонок — тоже: `b/pages` внутри `books/any(b: …)` это колонка книги.
      resolveColumnType: this.rebaseColumnTypeResolver(navigation),
    });

    inner.lambdaVariable = variable;
    inner.outerAlias = this.alias;
    // Имена без переменной лямбды разрешает внешний уровень — тем же способом, каким
    // разрешил бы их у себя. Замыкание, а не сама функция из опций: этот посетитель может
    // и сам быть телом лямбды, и тогда правило уровнем выше уже другое.
    inner.outerResolveColumnType = (path) => this.resolveTypeOfPath(path);
    // Псевдонимы `$compute` объявлены на внешнем уровне, и имя без переменной лямбды
    // относится туда же.
    inner.outerComputed = this.computed;
    inner.lambdaColumn = source.column;
    inner.parameterSeed = this.parameterSeed;

    inner.Visit(predicate, { target: 'where' });

    this.parameterSeed = inner.parameterSeed;

    for (const [name, value] of inner.parameters) {
      this.parameters.set(name, value);
    }

    for (const field of inner.referencedFields) {
      this.trackField([...navigation, field].join('/'));
    }

    for (const name of inner.lambdaRelations) {
      if (!this.lambdaRelations.includes(name)) {
        this.lambdaRelations.push(name);
      }
    }

    return inner.where;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Литералы
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Литерал в выражении.
   *
   * При `useParameters` (значение по умолчанию в базовом `Visitor`) значение не попадает в SQL:
   * в строку пишется именованный плейсхолдер `:pN`, а само значение кладётся в `parameters`.
   * Именно это делает фильтры устойчивыми к SQL-инъекциям.
   *
   * Литерал `null` в `parameters` не кладётся: выражение с ним всё равно будет переписано
   * в `IS NULL` в {@link TypeOrmVisitor.visitComparison}. Номер плейсхолдера при этом
   * расходуется — безобидно, нумерация остаётся сквозной и согласованной с картой параметров.
   */
  protected VisitLiteral(node: Token, context: Context) {
    // Парсер отдаёт для `null` узел Literal со значением-типом 'null'.
    this.lastLiteralWasNull = node.value === 'null';

    if (this.options.useParameters) {
      const name = `p${this.parameterSeed++}`;
      const value = this.convertLiteral(node);

      context.literal = value;

      if (!this.lastLiteralWasNull) {
        this.parameters.set(name, value);
      }

      this.append(context, `:${name}`);

      return;
    }

    context.literal = literalToSql(node.value, node.raw);

    this.append(context, String(context.literal));
  }

  /**
   * Приводит литерал OData к значению, пригодному для привязки параметра.
   *
   * В основном работу делает `Literal.convert` из `odata-v4-literal`, но для `Edm.TimeOfDay`
   * он возвращает полный момент времени (`08:00:00` → `1970-01-01T08:00:00.000Z`).
   * Сравнивать такое с результатом `TIME(x)` бессмысленно: и MySQL, и SQLite, и PostgreSQL
   * отдают оттуда `HH:MM:SS`, поэтому время суток привязывается исходной строкой.
   *
   * `Edm.Date` трогать не нужно — он и так конвертируется в `'2020-01-15'`.
   */
  private convertLiteral(node: Token): unknown {
    if (node.value === 'Edm.TimeOfDay') {
      return node.raw;
    }

    return convertLiteral(node.value, node.raw);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Функции OData
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Встроенные функции OData в выражениях.
   *
   * Строковые `contains` / `startswith` / `endswith` собираются в `LIKE`: шаблон с `%` кладётся
   * в `parameters` (пользовательская строка в SQL не инлайнится), а в выражение пишется
   * именованный плейсхолдер `:pN`.
   *
   * Плейсхолдер именно именованный, а не позиционный `?`: `asType()` → `asOracleSql()`
   * нумерует найденные `?` подряд с начала карты параметров, не зная, что `VisitLiteral`
   * уже расставил часть имён. Из-за этого `name eq 'x' and contains(title,'y')` давал
   * `u.name = :p0 AND u.title like :p0` — то есть тихо возвращал не те строки (дефект A-01).
   * Записывая имя сразу, мы не оставляем `asOracleSql()` работы.
   *
   * @throws {ODataUnsupportedError} для функции, у которой нет трансляции в SQL.
   */
  protected VisitMethodCallExpression(node: Token, context: Context) {
    const method = node.value.method as string;
    const params: Token[] = node.value.parameters || [];

    switch (method) {
      case 'contains':
        this.visitLikeExpression(params, context, (value) => `%${value}%`, 'contains');
        break;
      case 'startswith':
        this.visitLikeExpression(params, context, (value) => `${value}%`, 'startswith');
        break;
      case 'endswith':
        this.visitLikeExpression(params, context, (value) => `%${value}`, 'endswith');
        break;

      case 'indexof':
        this.visitIndexOf(params, context);
        break;

      case 'substring':
        this.visitSubstring(params, context);
        break;

      case 'concat':
        this.visitConcat(params, context);
        break;

      case 'length':
        // LEN — форма MS SQL; во всех остальных СУБД функция называется LENGTH.
        this.visitSimpleFunction(this.dialect === 'mssql' ? 'LEN' : 'LENGTH', params, context);
        break;
      case 'tolower':
        this.visitSimpleFunction('LOWER', params, context);
        break;
      case 'toupper':
        this.visitSimpleFunction('UPPER', params, context);
        break;
      case 'round':
        this.visitSimpleFunction('ROUND', params, context);
        break;
      case 'floor':
        this.visitSimpleFunction('FLOOR', params, context);
        break;
      case 'ceiling':
        // CEILING есть в MS SQL и SQLite, CEIL — в PostgreSQL, MySQL и Oracle.
        this.visitSimpleFunction(this.dialect === 'mssql' ? 'CEILING' : 'CEIL', params, context);
        break;

      case 'trim':
        this.append(context, 'TRIM(');
        this.Visit(argumentAt(params, 0, 'trim'), context);
        this.append(context, ')');
        break;

      case 'replace':
        this.visitReplace(params, context);
        break;

      case 'year':
      case 'month':
      case 'day':
      case 'hour':
      case 'minute':
      case 'second':
        this.visitDatePart(method, params, context);
        break;

      case 'fractionalseconds':
        this.visitFractionalSeconds(params, context);
        break;

      case 'totalseconds':
        this.visitTotalSeconds(params, context);
        break;

      case 'date':
        this.visitDateTimeCast('date', params, context);
        break;

      case 'time':
        this.visitDateTimeCast('time', params, context);
        break;

      case 'now':
        this.append(context, 'CURRENT_TIMESTAMP');
        break;

      case 'mindatetime':
        this.visitDateTimeBound('min', context);
        break;

      case 'maxdatetime':
        this.visitDateTimeBound('max', context);
        break;

      case 'cast':
        this.visitCast(params, context, node.raw);
        break;

      default:
        throw new ODataUnsupportedError(`${method}()`, node.raw);
    }
  }

  /**
   * Функция вида `ИМЯ(аргумент)` — единая форма для случаев без особенностей трансляции.
   */
  private visitSimpleFunction(sqlFunction: string, params: Token[], context: Context) {
    this.append(context, `${sqlFunction}(`);
    this.Visit(argumentAt(params, 0, sqlFunction), context);
    this.append(context, ')');
  }

  /**
   * Позиция подстроки: `indexof(haystack, needle)`.
   *
   * OData нумерует позиции с нуля, все три SQL-функции — с единицы, поэтому везде вычитается 1.
   * Порядок аргументов различается: `INSTR` и `POSITION` ждут (строка, искомое) и
   * (искомое IN строка) соответственно, `CHARINDEX` — (искомое, строка).
   */
  private visitIndexOf(params: Token[], context: Context) {
    const haystack = argumentAt(params, 0, 'indexof');
    const needle = argumentAt(params, 1, 'indexof');

    switch (this.dialect) {
      case 'mssql':
        this.append(context, 'CHARINDEX(');
        this.Visit(needle, context);
        this.append(context, ', ');
        this.Visit(haystack, context);
        this.append(context, ') - 1');
        break;

      case 'postgres':
      case 'ansi':
        // POSITION(искомое IN строка) — ANSI-форма, её же понимает PostgreSQL.
        this.append(context, 'POSITION(');
        this.Visit(needle, context);
        this.append(context, ' IN ');
        this.Visit(haystack, context);
        this.append(context, ') - 1');
        break;

      default:
        // MySQL, SQLite, Oracle
        this.append(context, 'INSTR(');
        this.Visit(haystack, context);
        this.append(context, ', ');
        this.Visit(needle, context);
        this.append(context, ') - 1');
        break;
    }
  }

  /**
   * Подстрока: `substring(str, start)` либо `substring(str, start, length)`.
   *
   * OData отсчитывает начало с нуля, SQL — с единицы, поэтому к позиции добавляется 1.
   * MS SQL требует третий аргумент всегда, поэтому при его отсутствии подставляется
   * длина самой строки — это заведомо «до конца».
   */
  private visitSubstring(params: Token[], context: Context) {
    const isMsSql = this.dialect === 'mssql';
    const sqlFunction = isMsSql ? 'SUBSTRING' : 'SUBSTR';

    const value = argumentAt(params, 0, 'substring');
    const start = argumentAt(params, 1, 'substring');
    const length = params[2];

    this.append(context, `${sqlFunction}(`);
    this.Visit(value, context);
    this.append(context, ', ');
    this.Visit(start, context);
    this.append(context, ' + 1');

    if (length) {
      this.append(context, ', ');
      this.Visit(length, context);
    } else if (isMsSql) {
      this.append(context, ', LEN(');
      this.Visit(value, context);
      this.append(context, ')');
    }

    this.append(context, ')');
  }

  /**
   * Замена подстроки: `replace(строка, что, чем)`.
   *
   * Единственная строковая функция OData, у которой нет диалектных расхождений вовсе:
   * `REPLACE` с той же сигнатурой есть в PostgreSQL, MySQL, SQLite, MS SQL и Oracle.
   * Поведение с `NULL` тоже общее — `NULL` в любом аргументе даёт `NULL`, то есть ровно
   * трёхзначную логику SQL, которую библиотека не переопределяет и в остальных местах.
   */
  private visitReplace(params: Token[], context: Context) {
    this.append(context, 'REPLACE(');
    this.Visit(argumentAt(params, 0, 'replace'), context);
    this.append(context, ', ');
    this.Visit(argumentAt(params, 1, 'replace'), context);
    this.append(context, ', ');
    this.Visit(argumentAt(params, 2, 'replace'), context);
    this.append(context, ')');
  }

  /**
   * Дробная часть секунд: `fractionalseconds(x)` — значение в диапазоне `[0, 1)`.
   *
   * Единой формы нет, как и у `year` / `month` / `day`:
   * - `EXTRACT(SECOND FROM x)` в PostgreSQL и Oracle возвращает секунды вместе с дробной
   *   частью, поэтому целую часть приходится вычитать;
   * - MySQL отдаёт микросекунды отдельной функцией;
   * - SQLite не умеет `EXTRACT`, а `strftime('%f')` возвращает строку `SS.SSS`;
   * - MS SQL считает наносекунды целым числом, поэтому делитель записан дробным —
   *   иначе целочисленное деление дало бы ноль на любом значении.
   *
   * У колонки объявленной точности `0` (`timestamp(0)`, `DATETIME` без дробной части)
   * результат всегда нулевой. Это не свойство трансляции, а отсутствие данных в хранилище.
   *
   * Аргумент обходится дважды в двух ветках из четырёх. Для колонки это ничего не стоит,
   * а для литерала расходует лишний номер параметра — так же, как `substring` в MS SQL,
   * где длина строки считается тем же способом.
   */
  private visitFractionalSeconds(params: Token[], context: Context) {
    const value = argumentAt(params, 0, 'fractionalseconds');

    if (this.dialect === 'mysql') {
      this.append(context, '(MICROSECOND(');
      this.Visit(value, context);
      this.append(context, ') / 1000000)');

      return;
    }

    if (this.dialect === 'sqlite') {
      this.append(context, "(CAST(strftime('%f', ");
      this.Visit(value, context);
      this.append(context, ") AS REAL) - CAST(strftime('%S', ");
      this.Visit(value, context);
      this.append(context, ') AS INTEGER))');

      return;
    }

    if (this.dialect === 'mssql') {
      this.append(context, '(DATEPART(nanosecond, ');
      this.Visit(value, context);
      this.append(context, ') / 1000000000.0)');

      return;
    }

    this.append(context, '(EXTRACT(SECOND FROM ');
    this.Visit(value, context);
    this.append(context, ') - FLOOR(EXTRACT(SECOND FROM ');
    this.Visit(value, context);
    this.append(context, ')))');
  }

  /**
   * Длительность в секундах: `totalseconds(x)`.
   *
   * ЛИТЕРАЛ сворачивается в число прямо при компиляции: `duration'PT1H'` — это значение,
   * известное до запроса, и SQL-функция для него не нужна ни в одном диалекте. Поэтому
   * `totalseconds(duration'…')` работает везде, включая СУБД без типа длительности.
   *
   * КОЛОНКА требует, чтобы тип длительности в СУБД существовал. Он есть только
   * в PostgreSQL (`interval`) и Oracle (`INTERVAL DAY TO SECOND`) — им и соответствует
   * единственный тип `Edm.Duration` в таблице `edmType`. В MySQL, SQLite и MS SQL такого
   * типа нет вовсе: колонки `Edm.Duration` там не бывает, и поддерживать нечего.
   *
   * @throws {ODataUnsupportedError} для колонки в диалекте без типа длительности.
   */
  private visitTotalSeconds(params: Token[], context: Context) {
    const value = argumentAt(params, 0, 'totalseconds');

    if (value.type === TokenType.Literal && value.value === 'Edm.Duration') {
      // convertLiteral отдаёт миллисекунды — единица `Edm.Duration` внутри библиотеки.
      const milliseconds = convertLiteral(value.value, value.raw) as number;

      this.appendComputed(context, milliseconds / 1000, String(milliseconds / 1000));

      return;
    }

    if (this.dialect === 'postgres') {
      this.append(context, 'EXTRACT(EPOCH FROM ');
      this.Visit(value, context);
      this.append(context, ')');

      return;
    }

    if (this.dialect === 'oracle') {
      // `EXTRACT(EPOCH …)` в Oracle нет, а `EXTRACT` над интервалом даёт составляющие
      // по отдельности — их и складываем.
      const parts: ReadonlyArray<readonly [string, number]> = [
        ['DAY', 86400],
        ['HOUR', 3600],
        ['MINUTE', 60],
        ['SECOND', 1],
      ];

      this.append(context, '(');

      parts.forEach(([part, multiplier], index) => {
        if (index > 0) {
          this.append(context, ' + ');
        }

        this.append(context, `EXTRACT(${part} FROM `);
        this.Visit(value, context);
        this.append(context, multiplier === 1 ? ')' : `) * ${multiplier}`);
      });

      this.append(context, ')');

      return;
    }

    throw new ODataUnsupportedError(
      `totalseconds() over a column in dialect "${this.dialect}"`,
      value.raw
    );
  }

  /**
   * Дописывает значение, вычисленное самой библиотекой, соблюдая режим параметров.
   *
   * Значение не приходит из запроса дословно (это результат свёртки литерала или константа
   * вроде границы диапазона дат), но путь до SQL у него общий с обычными литералами:
   * при `useParameters` в текст уходит `:pN`. Так номера параметров остаются сквозными,
   * а форма SQL — одинаковой независимо от того, что стояло в запросе.
   *
   * @param inline - запись значения в тексте SQL для режима `useParameters: false`.
   */
  private appendComputed(context: Context, value: unknown, inline: string) {
    if (this.options.useParameters) {
      const name = `p${this.parameterSeed++}`;

      this.parameters.set(name, value);
      context.literal = value;
      this.append(context, `:${name}`);

      return;
    }

    context.literal = value;
    this.append(context, inline);
  }

  /**
   * Границы диапазона `Edm.DateTimeOffset`: `mindatetime()` и `maxdatetime()`.
   *
   * Значение уезжает параметром, а не инлайном в SQL: формат записи даты у СУБД разный,
   * а привязку `Date` драйвер и так делает для каждого литерала даты-времени.
   * Сами границы и обоснование — в {@link dateTimeBound}.
   */
  private visitDateTimeBound(bound: 'min' | 'max', context: Context) {
    const value = dateTimeBound(bound, this.dialect);
    const inline = `'${value.toISOString().replace('T', ' ').replace('Z', '')}'`;

    this.appendComputed(context, value, inline);
  }

  /**
   * Приведение типа: `cast(x, Edm.String)`.
   *
   * Поддерживается только тотальное подмножество — приведения, которые не могут провалиться
   * (перечень и обоснование — в {@link resolveCast}). Остальные отвергаются целиком: по
   * спецификации неудачное приведение обязано дать `null`, а в SQL оно даёт ошибку, ноль или
   * предупреждение, и портируемого `TRY_CAST` не существует.
   *
   * Тип исходного выражения библиотека узнаёт двумя способами: у литерала он записан в самом
   * дереве, у колонки его отдаёт хук `resolveColumnType` из {@link SqlOptions}. Без него
   * (прямой вызов `createFilter` без метаданных) приведение отвергается — угадывать, может ли
   * `CAST` провалиться, библиотека не берётся.
   *
   * Форма `cast(<тип>)` без первого аргумента приводит текущий экземпляр сущности и смысла
   * в `$filter` не имеет: результат — сама сущность, сравнивать её не с чем.
   *
   * @throws {ODataUnsupportedError} для нетотального приведения, неизвестного типа исходного
   *   выражения, незнакомого драйвера и односоставной формы вызова.
   */
  private visitCast(params: Token[], context: Context, raw: string) {
    const value = argumentAt(params, 0, 'cast');
    const typeNode = argumentAt(params, 1, 'cast');

    if (typeNode.type !== TokenType.TypeReference) {
      throw new ODataUnsupportedError('cast() to something other than a type name', raw);
    }

    const target = typeNode.value.name as string;
    const source = this.inferEdmType(value);

    if (!source) {
      // Тип неизвестен: либо метаданных нет, либо приводится выражение, а не колонка.
      throw new ODataUnsupportedError(`cast() over an expression of unknown type`, raw);
    }

    const plan = resolveCast(source, target, this.dialect);

    if (plan === 'not-total') {
      // Пара названа целиком: без неё сообщение «cast не поддержан» заставляло бы гадать,
      // какое именно приведение библиотека отвергла.
      throw new ODataUnsupportedError(
        `cast from ${source} to ${target} (may fail at run time)`,
        raw
      );
    }

    if (plan === 'unknown-dialect') {
      throw new ODataUnsupportedError(`cast to ${target} in dialect "${this.dialect}"`, raw);
    }

    if (plan.form === 'identity') {
      this.Visit(value, context);

      return;
    }

    if (plan.form === 'function') {
      this.append(context, `${plan.sqlFunction}(`);
      this.Visit(value, context);
      this.append(context, ')');

      return;
    }

    this.append(context, 'CAST(');
    this.Visit(value, context);
    this.append(context, ` AS ${plan.sqlType})`);
  }

  /**
   * Конкатенация: `concat(a, b)`.
   *
   * Оператор `||` — ANSI-форма, работает в PostgreSQL, SQLite и Oracle. MySQL по умолчанию
   * трактует `||` как логическое ИЛИ, а MS SQL использует `+`, поэтому для них берётся `CONCAT`.
   */
  private visitConcat(params: Token[], context: Context) {
    const left = argumentAt(params, 0, 'concat');
    const right = argumentAt(params, 1, 'concat');

    if (this.dialect === 'mysql' || this.dialect === 'mssql') {
      this.append(context, 'CONCAT(');
      this.Visit(left, context);
      this.append(context, ', ');
      this.Visit(right, context);
      this.append(context, ')');

      return;
    }

    this.append(context, '(');
    this.Visit(left, context);
    this.append(context, ' || ');
    this.Visit(right, context);
    this.append(context, ')');
  }

  /**
   * Извлечение части даты: `year`, `month`, `day`, `hour`, `minute`, `second`.
   *
   * Единой формы нет ни одной, которая работала бы везде:
   * - `EXTRACT(YEAR FROM x)` — ANSI; понимают PostgreSQL, MySQL и Oracle;
   * - `DATEPART(year, x)` — MS SQL;
   * - `CAST(strftime('%Y', x) AS INTEGER)` — SQLite, где `EXTRACT` отсутствует, а `strftime`
   *   возвращает строку, поэтому нужен явный CAST, иначе сравнение с числом даст ложь.
   *
   * Именно этот случай и заставил ввести поле `dialect`: функций `YEAR` / `MONTH` / `DAY`,
   * которые генерировались раньше, нет ни в PostgreSQL, ни в SQLite.
   */
  private visitDatePart(method: string, params: Token[], context: Context) {
    /** Коды формата `strftime` для SQLite. */
    const sqliteFormats: Record<string, string> = {
      year: '%Y',
      month: '%m',
      day: '%d',
      hour: '%H',
      minute: '%M',
      second: '%S',
    };

    const value = argumentAt(params, 0, method);

    if (this.dialect === 'sqlite') {
      this.append(context, `CAST(strftime('${sqliteFormats[method]}', `);
      this.Visit(value, context);
      this.append(context, ') AS INTEGER)');

      return;
    }

    if (this.dialect === 'mssql') {
      this.append(context, `DATEPART(${method}, `);
      this.Visit(value, context);
      this.append(context, ')');

      return;
    }

    this.append(context, `EXTRACT(${method.toUpperCase()} FROM `);
    this.Visit(value, context);
    this.append(context, ')');
  }

  /**
   * Выделение календарной даты или времени суток: `date(x)`, `time(x)`.
   *
   * MySQL и SQLite имеют одноимённые функции; PostgreSQL и MS SQL приводят типом.
   * ANSI-форма `CAST(x AS DATE)` взята запасной — она же работает в PostgreSQL,
   * MS SQL и Oracle.
   */
  private visitDateTimeCast(part: 'date' | 'time', params: Token[], context: Context) {
    if (this.dialect === 'mysql' || this.dialect === 'sqlite') {
      this.visitSimpleFunction(part.toUpperCase(), params, context);

      return;
    }

    this.append(context, 'CAST(');
    this.Visit(argumentAt(params, 0, part), context);
    this.append(context, ` AS ${part.toUpperCase()})`);
  }

  /**
   * Общая форма `contains` / `startswith` / `endswith`.
   *
   * @param buildPattern - как обернуть значение символами `%` для конкретной функции.
   */
  private visitLikeExpression(
    params: Token[],
    context: Context,
    buildPattern: (value: string) => string,
    method: string
  ) {
    const column = argumentAt(params, 0, method);
    const pattern = argumentAt(params, 1, method);

    this.Visit(column, context);

    if (!this.options.useParameters) {
      // Режим без параметров: литерал инлайнится. literalToSql возвращает строку
      // в одинарных кавычках — снимаем их, чтобы вставить шаблон с % внутрь кавычек.
      const raw = String(literalToSql(pattern.value, pattern.raw)).slice(1, -1);

      this.append(context, ` LIKE '${buildPattern(raw)}'`);

      return;
    }

    const name = `p${this.parameterSeed++}`;
    const value = convertLiteral(pattern.value, pattern.raw);

    this.parameters.set(name, buildPattern(String(value)));

    this.append(context, ` LIKE :${name}`);
  }
}
