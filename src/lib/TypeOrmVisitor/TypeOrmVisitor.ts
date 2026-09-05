/**
 * Специализация посетителя `odata-v4-sql` для совместимости с TypeORM QueryBuilder.
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
 * и в фабричных функциях `createQuery` / `createFilter`.
 */
import { Literal } from 'odata-v4-literal';
import { type Token, TokenType } from 'odata-v4-parser/lib/lexer';
import { SQLLiteral, SQLLang, Visitor } from 'odata-v4-sql/lib/visitor';
import type { ObjectLiteral } from 'typeorm';

import type { SqlOptions } from '../types';

/**
 * Контекст обхода: в какое строковое поле посетителя (`where` | `select` | …) дописывать фрагменты,
 * как называется текущий идентификатор (для пост-обработки NULL-сравнений) и какое значение литерала
 * было разобрано последним.
 */
interface Context extends ObjectLiteral {
  target: string;
  identifier: string | Context;
  literal?: string;
}

export class TypeOrmVisitor extends Visitor {
  /** Дочерние посетители для каждого сегмента `$expand` (связь + собственный SELECT/WHERE/ORDER). */
  public includes: TypeOrmVisitor[] = [];
  /** Алиас таблицы/подзапроса для этой ветки AST (корень или имя навигации). */
  public alias = '';

  /**
   * Порядок разбора верхнеуровневых query options: сначала expand (чтобы появились JOIN-алиасы),
   * затем filter и select. Опции, не перечисленные здесь, получают indexOf -1 и оказываются «раньше»
   * в сортировке (то есть обрабатываются перед тремя перечисленными).
   */
  private queryOptionsSort = [TokenType.Expand, TokenType.Filter, TokenType.Select];

  constructor(options: SqlOptions) {
    super(options);

    this.type = SQLLang.Oracle;
    this.alias = options.alias || this.alias;
  }

  /**
   * Собирает полный SQL SELECT (наследие базового API посетителя): список полей, WHERE, ORDER BY,
   * и при необходимости Oracle-стиль пагинации OFFSET/FETCH.
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
   * `$expand`: для каждого элемента списка находим или создаём вложенный `TypeOrmVisitor` с уникальным
   * ключом `navigationProperty` (путь + позиция в AST), синхронизируем счётчик параметров и обходим ветку.
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
   * Один элемент `$select`: поддержка `Nav/Field` (через связанный include) и обычных имён с `/` → `.`.
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
   * Цепочка свойств в выражении (например `Author/Name`). В контексте `where` первая часть может быть
   * навигацией: тогда гарантируется наличие соответствующего include-посетителя; если expand в запросе
   * не было, создаётся «технический» include с пустым SELECT и тривиальным WHERE `1 = 1` только ради JOIN.
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
   * Имя поля или `NULL`: дописывает идентификатор в активный фрагмент (`context.target`) с учётом алиаса.
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
   * Префикс колонки: для корня — `this.alias.`, для цепочки после точки — подстановка алиаса связи
   * вместо корневого алиаса через `replace` накопленной строки.
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
   * Равенство: после обхода левой и правой частей превращает сравнение с NULL в `IS NULL`
   * (и симметричный вариант для параметра слева).
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
   * Неравенство: аналогично `VisitEqualsExpression`, но для `IS NOT NULL`.
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
   * Литерал в выражении: либо плейсхолдер `:pN` + запись в `parameters`, либо inline SQL-литерал.
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
   * Встроенные функции OData в фильтрах. Ветки `contains`/`startswith`/`endswith` формируют `LIKE`;
   * при `useParameters` в Map кладутся строки с `%`, а в SQL остаётся `like ?` (ожидается подстановка драйвером).
   * Остальные case-ы — прямые SQL-аналоги (`ROUND`, `LOWER`, дата/время и т.д.).
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
