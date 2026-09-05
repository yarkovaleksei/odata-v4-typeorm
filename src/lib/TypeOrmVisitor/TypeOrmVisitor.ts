/**
 * @file Специализация посетителя `odata-v4-sql` для совместимости с TypeORM QueryBuilder.
 *
 * Базовый класс `Visitor` при обходе AST OData накапливает строковые фрагменты SQL (`where`, `select`,
 * `orderby`), лимиты/смещения и `Map` параметров. Этот класс дополняет поведение:
 * - порядок обхода query options (`$expand` → `$filter` → `$select`) для согласованных алиасов;
 * - вложенные `$expand` как отдельные экземпляры `TypeOrmVisitor` в массиве `includes`;
 * - пути вида `связь/поле` в фильтрах и сортировке: автоматическое создание «виртуального» expand
 *   только ради JOIN, без выборки лишних колонок;
 * - сравнение с `null` в OData преобразуется в SQL `IS NULL` / `IS NOT NULL`;
 * - логическое отрицание `not`, арифметика (`add`, `sub`, `mul`, `div`, `mod`), унарный минус;
 * - строковые, числовые и календарные функции OData в `WHERE`.
 *
 * Диалект SQL жёстко выравнивается на Oracle-стиль в конструкторе и в фабричных функциях
 * `createQuery` / `createFilter`. Выбор именно Oracle не связан с СУБД пользователя: он сделан
 * потому, что `Visitor.asOracleSql()` переписывает позиционные плейсхолдеры `?` в именованные
 * `:pN`, а именно именованные параметры понимает TypeORM QueryBuilder.
 *
 * ЖИЗНЕННЫЙ ЦИКЛ. Результат обхода корректен только после вызова `asType()` — его делают
 * `createQuery` / `createFilter`. Если конструировать посетитель вручную, вызывать обязательно.
 *
 * ПРИНЦИП: молча ничего не терять. Узел AST, для которого нет обработчика, приводит к
 * {@link ODataUnsupportedError}, а не к пропуску части запроса. Раньше базовый класс печатал
 * такие узлы в `console.log` и продолжал обход, из-за чего `$filter=not (…)` возвращал всю
 * таблицу вместо подмножества.
 */
import { Literal } from 'odata-v4-literal';
import { type Token, TokenType } from 'odata-v4-parser/lib/lexer';
import { SQLLiteral, SQLLang, Visitor } from 'odata-v4-sql/lib/visitor';

import { ODataUnsupportedError } from '../errors';
import type { SqlDialect, SqlOptions } from '../types';

/**
 * Приведение значения `type` из настроек TypeORM к одному из поддерживаемых диалектов.
 *
 * TypeORM различает больше драйверов, чем существует диалектных различий: `mariadb` ведёт себя
 * как `mysql`, `better-sqlite3` — как `sqlite`, облачные варианты Postgres — как обычный Postgres.
 * Незнакомый драйвер сводится к `'ansi'`: там подставляются наиболее переносимые конструкции.
 */
function normalizeDialect(driver?: string): SqlDialect {
  switch (driver) {
    case 'postgres':
    case 'aurora-postgres':
    case 'cockroachdb':
      return 'postgres';
    case 'mysql':
    case 'mariadb':
    case 'aurora-mysql':
      return 'mysql';
    case 'sqlite':
    case 'better-sqlite3':
    case 'capacitor':
    case 'cordova':
    case 'expo':
    case 'nativescript':
    case 'sqljs':
      return 'sqlite';
    case 'mssql':
      return 'mssql';
    case 'oracle':
      return 'oracle';
    default:
      return 'ansi';
  }
}

/** Строковые поля посетителя, в которые ветки обхода дописывают SQL. */
type TargetField = 'where' | 'select' | 'orderby';

/**
 * Признак лямбда-оператора OData (`posts/any(p: …)`, `posts/all(p: …)`) в тексте пути.
 *
 * Проверка текстовая, потому что структурно поймать такой узел невозможно: парсер этой версии
 * тело лямбды теряет и отдаёт обычный путь свойства.
 */
const LAMBDA_OPERATOR = /\/(any|all)\s*\(/i;

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

export class TypeOrmVisitor extends Visitor {
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
   * Порядок разбора верхнеуровневых query options: сначала expand (чтобы появились JOIN-алиасы),
   * затем filter и select. Опции, не перечисленные здесь, получают indexOf -1 и оказываются «раньше»
   * в сортировке (то есть обрабатываются перед тремя перечисленными).
   */
  private queryOptionsSort = [TokenType.Expand, TokenType.Filter, TokenType.Select];

  /**
   * Признак «последним разобранным литералом был `null`».
   *
   * Нужен, чтобы отличить `field eq null` от `field eq :pN`. Через `context.literal` это
   * сделать нельзя: у операнда-идентификатора литерала нет вовсе, и `undefined` неотличим
   * от разобранного `null`.
   */
  private lastLiteralWasNull = false;

  /**
   * Служебный признак: include создан ради JOIN (фильтр или сортировка по пути `связь/поле`),
   * а не по явному `$expand`. Первый же `$expand` этой связи снимает флаг и переводит
   * посетитель в обычный режим — с выборкой колонок.
   */
  private isVirtual = false;

  /** Целевая СУБД: определяет, какие SQL-функции подставлять для функций OData. */
  private readonly dialect: SqlDialect;

  constructor(options: SqlOptions) {
    super(options);

    // SQLLang фиксируем здесь, а не берём из options: от него зависит формат плейсхолдеров,
    // который приводит в порядок asType() (см. заголовок файла). К выбору SQL-функций
    // он отношения не имеет — за это отвечает отдельное поле dialect.
    this.type = SQLLang.Oracle;
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
  Visit(node: Token, context?: Context): this {
    if (node) {
      const handlerName = `Visit${node.type}` as keyof this;

      if (typeof this[handlerName] !== 'function') {
        throw new ODataUnsupportedError(node.type, node.raw);
      }
    }

    return super.Visit(node, context);
  }

  /**
   * Собирает полный SQL SELECT (наследие базового API посетителя): список полей, WHERE, ORDER BY,
   * и при необходимости Oracle-стиль пагинации OFFSET/FETCH.
   *
   * В сценарии с TypeORM этот метод не используется — QueryBuilder собирает SQL сам из
   * `select` / `where` / `parameters`. `from()` нужен для «сырого» сценария (`createFilter` +
   * драйвер БД, см. `src/example/sql.ts`).
   *
   * @param table - имя таблицы; подставляется в SQL как есть, без экранирования, поэтому
   *   передавать сюда пользовательский ввод нельзя.
   */
  from(table: string) {
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
   * Включает и связи из `$expand`, и «виртуальные» — созданные путями `связь/поле`
   * в фильтрах и сортировке.
   *
   * @returns имена связей без путей: для `$expand=books($expand=reviews)` — `['books', 'reviews']`.
   */
  public collectNavigationProperties(): string[] {
    const result: string[] = [];

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

  /** Регистрирует упомянутый путь свойства; повторы отбрасываются. */
  private trackField(path: string): void {
    if (!this.referencedFields.includes(path)) {
      this.referencedFields.push(path);
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

      // Служебные значения виртуального include ('' / '1 = 1') сбрасываются, иначе разбор
      // вложенных опций дописал бы SQL к ним: `$expand=books($orderby=id)` дал бы '1Author_books.id'.
      // Повторный $expand той же связи сбрасывает только умолчания, но сохраняет уже
      // накопленный $select — так две ветки объединяются в один JOIN с общим списком колонок.
      visitor.isVirtual = false;

      if (visitor.where === '1 = 1') {
        visitor.where = '';
      }

      if (visitor.orderby === '1') {
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
      this.select = '*';
    }

    if (!this.where) {
      this.where = '1 = 1';
    }

    if (!this.orderby) {
      this.orderby = '1';
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
    // Лямбда-операторы отлавливаются здесь, а не в Visit: `odata-v4-parser` 0.1.29 не создаёт
    // для них отдельного узла — он молча отбрасывает тело лямбды и оставляет обычный путь
    // свойства, у которого в `raw` ещё виден исходный текст. Без этой проверки
    // `$filter=posts/any(p: p/title eq 'x')` скомпилировался бы в бессмысленное `u.posts`.
    if (LAMBDA_OPERATOR.test(node.raw)) {
      throw new ODataUnsupportedError('lambda operators (any/all)', node.raw);
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
    });

    visitor.parameterSeed = this.parameterSeed;
    visitor.navigationProperty = navigationProperty;
    visitor.isVirtual = true;
    visitor.select = '';
    visitor.where = '1 = 1';

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
    this.trackField(node.value.name);

    this.append(context, this.qualify(node.value.name));

    context.identifier = node.value.name;
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
   * Отличается от `VisitBoolParenExpression` (он в базовом классе) тем, что группирует
   * не булево подвыражение, а арифметическое.
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
      const value = Literal.convert(node.value, node.raw);

      context.literal = value;

      if (!this.lastLiteralWasNull) {
        this.parameters.set(name, value);
      }

      this.append(context, `:${name}`);

      return;
    }

    context.literal = SQLLiteral.convert(node.value, node.raw);

    this.append(context, String(context.literal));
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
        this.visitLikeExpression(params, context, (value) => `%${value}%`);
        break;
      case 'startswith':
        this.visitLikeExpression(params, context, (value) => `${value}%`);
        break;
      case 'endswith':
        this.visitLikeExpression(params, context, (value) => `%${value}`);
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
        this.Visit(params[0], context);
        this.append(context, ')');
        break;

      case 'year':
      case 'month':
      case 'day':
      case 'hour':
      case 'minute':
      case 'second':
        this.visitDatePart(method, params, context);
        break;

      case 'now':
        this.append(context, 'CURRENT_TIMESTAMP');
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
    this.Visit(params[0], context);
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
    switch (this.dialect) {
      case 'mssql':
        this.append(context, 'CHARINDEX(');
        this.Visit(params[1], context);
        this.append(context, ', ');
        this.Visit(params[0], context);
        this.append(context, ') - 1');
        break;

      case 'postgres':
      case 'ansi':
        // POSITION(искомое IN строка) — ANSI-форма, её же понимает PostgreSQL.
        this.append(context, 'POSITION(');
        this.Visit(params[1], context);
        this.append(context, ' IN ');
        this.Visit(params[0], context);
        this.append(context, ') - 1');
        break;

      default:
        // MySQL, SQLite, Oracle
        this.append(context, 'INSTR(');
        this.Visit(params[0], context);
        this.append(context, ', ');
        this.Visit(params[1], context);
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

    this.append(context, `${sqlFunction}(`);
    this.Visit(params[0], context);
    this.append(context, ', ');
    this.Visit(params[1], context);
    this.append(context, ' + 1');

    if (params[2]) {
      this.append(context, ', ');
      this.Visit(params[2], context);
    } else if (isMsSql) {
      this.append(context, ', LEN(');
      this.Visit(params[0], context);
      this.append(context, ')');
    }

    this.append(context, ')');
  }

  /**
   * Конкатенация: `concat(a, b)`.
   *
   * Оператор `||` — ANSI-форма, работает в PostgreSQL, SQLite и Oracle. MySQL по умолчанию
   * трактует `||` как логическое ИЛИ, а MS SQL использует `+`, поэтому для них берётся `CONCAT`.
   */
  private visitConcat(params: Token[], context: Context) {
    if (this.dialect === 'mysql' || this.dialect === 'mssql') {
      this.append(context, 'CONCAT(');
      this.Visit(params[0], context);
      this.append(context, ', ');
      this.Visit(params[1], context);
      this.append(context, ')');

      return;
    }

    this.append(context, '(');
    this.Visit(params[0], context);
    this.append(context, ' || ');
    this.Visit(params[1], context);
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

    if (this.dialect === 'sqlite') {
      this.append(context, `CAST(strftime('${sqliteFormats[method]}', `);
      this.Visit(params[0], context);
      this.append(context, ') AS INTEGER)');

      return;
    }

    if (this.dialect === 'mssql') {
      this.append(context, `DATEPART(${method}, `);
      this.Visit(params[0], context);
      this.append(context, ')');

      return;
    }

    this.append(context, `EXTRACT(${method.toUpperCase()} FROM `);
    this.Visit(params[0], context);
    this.append(context, ')');
  }

  /**
   * Общая форма `contains` / `startswith` / `endswith`.
   *
   * @param buildPattern - как обернуть значение символами `%` для конкретной функции.
   */
  private visitLikeExpression(
    params: Token[],
    context: Context,
    buildPattern: (value: string) => string
  ) {
    this.Visit(params[0], context);

    if (!this.options.useParameters) {
      // Режим без параметров: литерал инлайнится. SQLLiteral.convert возвращает строку
      // в одинарных кавычках — снимаем их, чтобы вставить шаблон с % внутрь кавычек.
      const raw = String(SQLLiteral.convert(params[1].value, params[1].raw)).slice(1, -1);

      this.append(context, ` LIKE '${buildPattern(raw)}'`);

      return;
    }

    const name = `p${this.parameterSeed++}`;
    const value = Literal.convert(params[1].value, params[1].raw);

    this.parameters.set(name, buildPattern(String(value)));

    this.append(context, ` LIKE :${name}`);
  }
}
