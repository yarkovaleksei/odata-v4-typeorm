/**
 * @file Специализация посетителя `odata-v4-sql` для совместимости с TypeORM QueryBuilder.
 *
 * Базовый класс `Visitor` при обходе AST OData накапливает строковые фрагменты SQL (`where`, `select`,
 * `orderby`), лимиты/смещения и `Map` параметров. Этот класс дополняет поведение:
 * - порядок обхода query options (`$expand` → `$filter` → `$select`) для согласованных алиасов;
 * - вложенные `$expand` как отдельные экземпляры `TypeOrmVisitor` в массиве `includes`;
 * - пути вида `nav/prop` в фильтрах: автоматическое создание «виртуального» expand только для JOIN,
 *   без выборки лишних колонок;
 * - сравнение с `null` в OData преобразуется в SQL `IS NULL` / `IS NOT NULL`;
 * - частичная поддержка строковых функций OData (`contains`, `startswith`, …) в `WHERE`.
 *
 * Диалект SQL жёстко выравнивается на Oracle-стиль (`FETCH NEXT`, `OFFSET … ROWS`) в конструкторе
 * и в фабричных функциях `createQuery` / `createFilter`. Выбор именно Oracle не связан с СУБД
 * пользователя: он выбран потому, что `Visitor.asOracleSql()` переписывает позиционные плейсхолдеры
 * `?` в именованные `:pN`, а именно именованные параметры понимает TypeORM QueryBuilder.
 *
 * ВАЖНО (жизненный цикл объекта). Результат обхода корректен только после вызова `asType()` —
 * его делают `createQuery` / `createFilter`. До `asType()` в `where` могут оставаться `?`
 * (см. `VisitMethodCallExpression`). Если конструировать посетитель вручную, `asType()` вызывать
 * обязательно.
 *
 * Известные ограничения этого класса задокументированы у соответствующих методов и сведены
 * в `docs/audit.md` (раздел «Дефекты»).
 */
import { Literal } from 'odata-v4-literal';
import { type Token, TokenType } from 'odata-v4-parser/lib/lexer';
import { SQLLiteral, SQLLang, Visitor } from 'odata-v4-sql/lib/visitor';
import type { ObjectLiteral } from 'typeorm';

import type { SqlOptions } from '../types';

/**
 * Контекст обхода AST, который передаётся сверху вниз по рекурсии `Visit`.
 *
 * @property target - имя строкового поля посетителя (`'where'` | `'select'` | `'orderby'`),
 *   в которое текущая ветка дописывает SQL. Обращение к нему динамическое (`this[context.target]`),
 *   поэтому в коде стоят точечные `@ts-ignore`.
 * @property identifier - последний разобранный идентификатор. Используется двояко:
 *   как маркер «мы внутри цепочки `a/b/c`» (значение заканчивается на `.`) и как подстановка
 *   в регулярные выражения пост-обработки `IS NULL` / `IS NOT NULL`.
 * @property literal - значение последнего литерала. `null`/`undefined` здесь означает
 *   «в OData было написано `null`», что и запускает замену `= :pN` → `IS NULL`.
 */
interface Context extends ObjectLiteral {
  target: string;
  identifier: string | Context;
  literal?: string;
}

export class TypeOrmVisitor extends Visitor {
  /**
   * Дочерние посетители — по одному на каждый сегмент `$expand` (связь + собственный SELECT/WHERE/ORDER).
   * Заполняется в {@link TypeOrmVisitor.VisitExpand} и в {@link TypeOrmVisitor.VisitPropertyPathExpression}
   * (для «виртуальных» JOIN-ов, нужных фильтру по пути `связь/поле`).
   * Дальше это дерево разворачивается в цепочку `leftJoin` в `processIncludes`.
   */
  public includes: TypeOrmVisitor[] = [];
  /**
   * SQL-алиас таблицы для этой ветки AST.
   * Для корня — значение `options.alias`; для ветки `$expand` — `<путь><позиция в исходной строке>`
   * (например `posts8`), что делает алиас уникальным при нескольких expand одной и той же связи.
   */
  public alias = '';

  /**
   * Порядок разбора верхнеуровневых query options: сначала expand (чтобы появились JOIN-алиасы),
   * затем filter и select. Опции, не перечисленные здесь, получают indexOf -1 и оказываются «раньше»
   * в сортировке (то есть обрабатываются перед тремя перечисленными).
   */
  private queryOptionsSort = [TokenType.Expand, TokenType.Filter, TokenType.Select];

  constructor(options: SqlOptions) {
    super(options);

    // Диалект фиксируем здесь, а не берём из options: от него зависит формат плейсхолдеров,
    // который переписывает asType() (см. заголовок файла).
    this.type = SQLLang.Oracle;
    this.alias = options.alias || this.alias;
  }

  /**
   * Собирает полный SQL SELECT (наследие базового API посетителя): список полей, WHERE, ORDER BY,
   * и при необходимости Oracle-стиль пагинации OFFSET/FETCH.
   *
   * В сценарии с TypeORM этот метод не используется — QueryBuilder собирает SQL сам из
   * `select` / `where` / `parameters`. `from()` нужен для «сырого» сценария (`createFilter` + драйвер БД,
   * см. `src/example/sql.ts`).
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
   * `$expand`: для каждого элемента списка создаётся вложенный `TypeOrmVisitor`, обходящий свою ветку
   * AST независимо (свои `select` / `where` / `orderby`).
   *
   * `parameterSeed` передаётся в дочерний посетитель и забирается обратно, чтобы сквозная нумерация
   * `:p0, :p1, …` не пересекалась между корнем и вложенными ветками.
   *
   * Алиас дочерней ветки — `<путь><позиция>` (`posts8`), а вот `navigationProperty` базовый
   * `VisitExpandItem` выставит равным чистому пути (`posts`).
   *
   * ВНИМАНИЕ: проверка на переиспользование сравнивает `navigationProperty` (`'posts'`) с `expandPath`
   * (`'posts8'`), поэтому она никогда не срабатывает — повторный `$expand` одной и той же связи
   * даёт два независимых include и два `LEFT JOIN`. См. `docs/audit.md`, дефект A-04.
   */
  protected VisitExpand(node: Token) {
    node.value.items.forEach((item: Token) => {
      const expandPath = `${item.value.path.raw}${item.position}`;
      let visitor = this.includes.filter((v) => v.navigationProperty == expandPath)[0];

      if (!visitor) {
        visitor = new TypeOrmVisitor({ ...this.options, alias: expandPath });
        visitor.parameterSeed = this.parameterSeed;

        this.includes.push(visitor);
      }

      visitor.Visit(item);

      this.parameterSeed = visitor.parameterSeed;
    });
  }

  /**
   * Один элемент `$select`.
   *
   * Две ветки:
   * 1. `Nav/Field` — ищем уже созданный include по `navigationProperty` и берём его реальный
   *    JOIN-алиас (`posts8.title`). Если include не найден (не было `$expand`), алиасом становится
   *    само имя связи — такой SQL валиден только если TypeORM действительно заджойнил её под этим именем.
   * 2. Обычное поле — префиксуется корневым алиасом через `getIdentifier`.
   *
   * Первый `if` дописывает разделитель `', '`, второй (внутри ветки 2) — ещё и `','`; для одиночных
   * и множественных `$select` результат совпадает с ожиданиями тестов, но код дублирует логику
   * разделителя. См. `docs/roadmap.md`, задача R-29.
   */
  protected VisitSelectItem(node: Token, context: Context) {
    if (this.select !== '' && !this.select.trim().endsWith(',')) {
      this.select += ', ';
    }

    if (node.raw.includes('/')) {
      const itemSplit = node.raw.split('/');
      const itemName = itemSplit[0];
      const item = this.includes.find((x) => x.navigationProperty === itemName);

      let alias = itemSplit[0];

      if (item) {
        alias = item.alias;
      }

      this.select += `${alias}.${itemSplit[1]}`;

      return;
    }

    const item = node.raw.replace(/\//g, '.');

    this.select +=
      (this.select && !this.select.trim().endsWith(',') ? ',' : '') +
      this.getIdentifier(item, context.identifier as Context);
  }

  /**
   * Цепочка свойств в выражении (например `Author/Name`).
   *
   * В контексте `where` первая часть пути может быть навигацией, и тогда для неё нужен JOIN.
   * Если `$expand` этой связи в запросе не было, создаётся «технический» include: `select = ''`
   * (колонки связи в выборку не попадают) и `where = '1 = 1'` (JOIN без дополнительного условия).
   *
   * ВНИМАНИЕ: имя JOIN-алиаса, которое подставляется в WHERE, — это чистое имя связи (`posts.title`),
   * тогда как `VisitExpand` создаёт алиас с позицией (`posts8`). Поэтому комбинация
   * `$expand=posts&$filter=posts/title eq '…'` даёт ссылку на несуществующий алиас и ошибку СУБД.
   * См. `docs/audit.md`, дефект A-02.
   *
   * Вторая половина метода — собственно обход: для составного пути рекурсивно посещаются `current`
   * и `next`, а между ними в `context.identifier` дописывается `'.'` — этот суффикс служит сигналом
   * для `getIdentifier` / `VisitODataIdentifier`, что корневой алиас подставлять уже не нужно.
   */
  protected VisitPropertyPathExpression(node: Token, context: Context) {
    if (context.target === 'where' && node.value.current) {
      // В фильтре путь `связь/поле` требует JOIN: убеждаемся, что для связи есть include-посетитель.
      const expandPath = node.value.current.value.name;
      let visitor = this.includes.filter((v) => v.navigationProperty == expandPath)[0];

      if (!visitor) {
        visitor = new TypeOrmVisitor({ ...this.options, alias: expandPath });
        visitor.parameterSeed = this.parameterSeed;

        this.includes.push(visitor);

        visitor.Visit(node.value.current);

        // Связь нужна только для условия, без выборки колонок в SELECT.
        visitor.where = '1 = 1';
        visitor.select = '';
        visitor.navigationProperty = expandPath;
      }
    }

    if (node.value.current && node.value.next) {
      this.Visit(node.value.current, context);

      context.identifier += '.';

      this.Visit(node.value.next, context);
    } else {
      this.Visit(node.value, context);
    }
  }

  /**
   * Имя поля или литерал `NULL`: дописывает идентификатор в активный фрагмент (`context.target`).
   *
   * Ключевой момент — `NULL` в OData приходит сюда как обычный идентификатор с именем `'NULL'`,
   * поэтому его нельзя префиксовать алиасом (`u.NULL`); он пишется как есть, а превращением
   * `= NULL` → `IS NULL` занимаются `VisitEqualsExpression` / `VisitNotEqualsExpression`.
   */
  protected VisitODataIdentifier(node: Token, context: Context) {
    if (context.identifier && context.identifier.endsWith('.')) {
      // @ts-ignore — динамическое обращение к полям Visitor (`where`, `select`, …).
      this[context.target] += '.';
    }

    if (node.value.name === 'NULL') {
      // @ts-ignore
      this[context.target] += node.value.name;
    } else {
      const ident = this.getIdentifier(node.value.name, context);

      // @ts-ignore
      this[context.target] += ident;
    }

    context.identifier = node.value.name;
  }

  /**
   * Возвращает идентификатор колонки с нужным префиксом.
   *
   * Два режима:
   * - контекста нет либо предыдущий идентификатор не заканчивается на `'.'` → это первое звено пути,
   *   префиксуем корневым алиасом: `id` → `u.id`;
   * - предыдущий идентификатор заканчивается на `'.'` → мы внутри цепочки `Profile/Age`. К этому моменту
   *   в накопленную строку уже попало `u.Profile.`, что неверно: `Profile` — это JOIN-алиас, а не колонка
   *   таблицы `u`. Поэтому выполняется ретроактивная правка уже записанного фрагмента —
   *   `u.Profile.` заменяется на `Profile.`, — а сам идентификатор возвращается без префикса.
   *
   * Ретроактивный `replace` по регулярному выражению — самое хрупкое место класса: `context.identifier`
   * попадает в `RegExp` без экранирования, а `.` в шаблоне трактуется как «любой символ».
   * См. `docs/roadmap.md`, задача R-26.
   */
  private getIdentifier(originalIdentifier: string, context: Context) {
    let alias = '';

    if (!context || !context.identifier || !context.identifier.endsWith('.')) {
      alias = `${this.alias}.`;
    } else {
      // @ts-ignore
      this[context.target] = this[context.target].replace(
        new RegExp(`${this.alias}.${context.identifier}`, 'g'),
        context.identifier
      );
    }

    return `${alias}${originalIdentifier}`;
  }

  /**
   * Равенство `eq`.
   *
   * Сначала обычная генерация `<left> = <right>`, затем пост-обработка: SQL-семантика требует
   * `IS NULL` вместо `= NULL`, а к моменту обхода правой части мы уже не знаем, будет ли там `null`.
   * Поэтому признак «справа был null» берётся из `context.literal`, выставленного в `VisitLiteral`,
   * и уже готовый хвост строки `where` переписывается регулярным выражением.
   *
   * Два зеркальных `replace` покрывают оба порядка операндов (`field eq null` и `null eq field`).
   */
  protected VisitEqualsExpression(node: Token, context: Context) {
    this.Visit(node.value.left, context);

    this.where += ' = ';

    this.Visit(node.value.right, context);

    if (this.options.useParameters && context.literal == null) {
      this.where = this.where
        .replace(/= :p\d*$/, 'IS NULL')
        .replace(new RegExp(`\\:p\\d* = ${context.identifier}$`), `${context.identifier} IS NULL`);
    } else if (context.literal == 'NULL') {
      this.where = this.where
        .replace(/= NULL$/, 'IS NULL')
        .replace(new RegExp(`NULL = ${context.identifier}$`), `${context.identifier} IS NULL`);
    }
  }

  /**
   * Неравенство `ne` — полный аналог {@link TypeOrmVisitor.VisitEqualsExpression},
   * но с оператором `<>` и заменой на `IS NOT NULL`.
   */
  protected VisitNotEqualsExpression(node: Token, context: Context) {
    this.Visit(node.value.left, context);

    this.where += ' <> ';

    this.Visit(node.value.right, context);

    if (this.options.useParameters && context.literal == null) {
      this.where = this.where
        .replace(/<> :p\d*$/, 'IS NOT NULL')
        .replace(
          new RegExp(`\\:p\\d* <> ${context.identifier}$`),
          `${context.identifier} IS NOT NULL`
        );
    } else if (context.literal == 'NULL') {
      this.where = this.where
        .replace(/<> NULL$/, 'IS NOT NULL')
        .replace(new RegExp(`NULL <> ${context.identifier}$`), `${context.identifier} IS NOT NULL`);
    }
  }

  /**
   * Литерал в выражении.
   *
   * При `useParameters` (значение по умолчанию в базовом `Visitor`) значение не попадает в SQL:
   * в строку пишется именованный плейсхолдер `:pN`, а само значение кладётся в `parameters`.
   * Именно это делает фильтры устойчивыми к SQL-инъекциям.
   *
   * `context.literal` выставляется всегда — в том числе в `null`, когда в OData было написано `null`.
   * По этому признаку `VisitEqualsExpression` отличает `field eq null` от `field eq :pN`.
   * Значение `null` в `parameters` намеренно не кладётся: оно всё равно будет вырезано из SQL
   * заменой на `IS NULL`.
   *
   * Без `useParameters` литерал инлайнится в SQL через `SQLLiteral.convert` — режим для отладки
   * и для генерации «сырых» запросов, но не для пользовательского ввода.
   */
  protected VisitLiteral(node: Token, context: Context) {
    if (this.options.useParameters) {
      const name = `p${this.parameterSeed++}`;
      const value = Literal.convert(node.value, node.raw);

      context.literal = value;

      if (context.literal != null) {
        this.parameters.set(name, value);
      }

      this.where += `:${name}`;
    } else this.where += context.literal = SQLLiteral.convert(node.value, node.raw);
  }

  /**
   * Встроенные функции OData в фильтрах.
   *
   * Ветки `contains` / `startswith` / `endswith` собирают `LIKE`: шаблон с `%` кладётся в `parameters`
   * (то есть пользовательская строка не инлайнится в SQL), а в `where` пишется позиционный
   * плейсхолдер `?`. Позже `asType()` → `Visitor.asOracleSql()` меняет все `?` на именованные `:pN`,
   * которые понимает TypeORM.
   *
   * ДЕФЕКТ (A-01, см. `docs/audit.md`). `asOracleSql()` нумерует `?` подряд с начала `parameters`,
   * не зная, что `VisitLiteral` в этом классе уже записал часть плейсхолдеров именованными.
   * Из-за этого при смешивании обычного сравнения и LIKE имена разъезжаются:
   *
   *   $filter=name eq 'x' and contains(title,'y')
   *     → where  : u.name = :p0 AND u.title like :p0   // должно быть :p1
   *     → params : { p0: 'x', p1: '%y%' }
   *
   * Запрос при этом не падает — он молча возвращает не те строки. Лечится переходом на `:${name}`
   * вместо `?` в трёх ветках ниже (тогда `asOracleSql` просто не найдёт что заменять).
   *
   * Остальные case-ы — прямая трансляция в SQL-функции. Обратите внимание, что часть имён
   * не переносима между СУБД: `LEN` для `length` есть в MS SQL, но не в PostgreSQL/SQLite
   * (там `LENGTH`), `NOW()` отсутствует в MS SQL и SQLite. Ветвление по `this.type` сделано только
   * для `indexof`, и оно недостижимо: конструктор жёстко ставит `SQLLang.Oracle`, поэтому
   * `CHARINDEX` не выбирается никогда. См. `docs/audit.md`, дефект A-06.
   *
   * Не реализованы (узел просто ничего не допишет в `where`, что даёт синтаксически битый SQL):
   * `substring`, `concat`, `replace`, `date`, `time`, `totaloffsetminutes`, `mindatetime`,
   * `maxdatetime`, `fractionalseconds`, `cast`, `isof`, геопространственные функции.
   */
  protected VisitMethodCallExpression(node: Token, context: Context) {
    const method = node.value.method;
    const params = node.value.parameters || [];
    let indexofFn: string;

    switch (method) {
      case 'contains':
        this.Visit(params[0], context);

        if (this.options.useParameters) {
          const name = `p${this.parameterSeed++}`;
          const value = Literal.convert(params[1].value, params[1].raw);

          this.parameters.set(name, `%${value}%`);
          this.where += ' like ?';
        } else
          this.where += ` like '%${SQLLiteral.convert(params[1].value, params[1].raw).slice(1, -1)}%'`;
        break;
      case 'endswith':
        this.Visit(params[0], context);

        if (this.options.useParameters) {
          const name = `p${this.parameterSeed++}`;
          const value = Literal.convert(params[1].value, params[1].raw);

          this.parameters.set(name, `%${value}`);
          this.where += ' like ?';
        } else
          this.where += ` like '%${SQLLiteral.convert(params[1].value, params[1].raw).slice(1, -1)}'`;
        break;
      case 'startswith':
        this.Visit(params[0], context);

        if (this.options.useParameters) {
          const name = `p${this.parameterSeed++}`;
          const value = Literal.convert(params[1].value, params[1].raw);

          this.parameters.set(name, `${value}%`);
          this.where += ' like ?';
        } else
          this.where += ` like '${SQLLiteral.convert(params[1].value, params[1].raw).slice(1, -1)}%'`;
        break;
      case 'indexof':
        switch (this.type) {
          case SQLLang.MsSql:
            indexofFn = 'CHARINDEX';
            break;
          case SQLLang.ANSI:
          case SQLLang.MySql:
          case SQLLang.PostgreSql:
          default:
            indexofFn = 'INSTR';
            break;
        }

        if (indexofFn === 'CHARINDEX') {
          const tmp = params[0];

          params[0] = params[1];
          params[1] = tmp;
        }

        this.where += `${indexofFn}(`;
        this.Visit(params[0], context);
        this.where += ', ';
        this.Visit(params[1], context);
        this.where += ') - 1';
        break;
      case 'round':
        this.where += 'ROUND(';
        this.Visit(params[0], context);
        this.where += ')';
        break;
      case 'length':
        this.where += 'LEN(';
        this.Visit(params[0], context);
        this.where += ')';
        break;
      case 'tolower':
        this.where += 'LOWER(';
        this.Visit(params[0], context);
        this.where += ')';
        break;
      case 'toupper':
        this.where += 'UPPER(';
        this.Visit(params[0], context);
        this.where += ')';
        break;
      case 'floor':
      case 'ceiling':
      case 'year':
      case 'month':
      case 'day':
      case 'hour':
      case 'minute':
      case 'second':
        this.where += `${method.toUpperCase()}(`;
        this.Visit(params[0], context);
        this.where += ')';
        break;
      case 'now':
        this.where += 'NOW()';
        break;
      case 'trim':
        this.where += "TRIM(' ' FROM ";
        this.Visit(params[0], context);
        this.where += ')';
        break;
    }
  }
}
