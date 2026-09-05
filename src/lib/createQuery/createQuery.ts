/**
 * Компиляция полной OData query string (или уже разобранного AST) в объект-посетитель TypeORM.
 *
 * Цепочка: строка → парсер `odata-v4-parser` → AST (`Token`) → обход через `TypeOrmVisitor`
 * (наследник `odata-v4-sql` Visitor) → результат с полями `where`, `select`, `orderby`, `parameters`,
 * вложенными `includes` для `$expand` и т.д.
 *
 * Явно выставляется `SQLLang.Oracle`, чтобы совпадать с диалектом, под который заточены
 * шаблоны SQL в базовом посетителе и переопределениях (`FETCH NEXT …`, `OFFSET … ROWS`).
 */
import { query } from 'odata-v4-parser';
import type { Token } from 'odata-v4-parser/lib/lexer';
import { SQLLang } from 'odata-v4-sql';

import { TypeOrmVisitor } from '../TypeOrmVisitor';
import type { SqlOptions } from '../types';

/**
 * Собирает дескриптор запроса (фрагменты SQL и метаданные) из OData query.
 *
 * @param odataQuery - либо полная строка query options OData, либо готовый AST.
 * @param options - опции SQL-генерации; обязателен `alias` корневой сущности.
 * @returns экземпляр `TypeOrmVisitor` после обхода AST (`asType()` уже применён внутри).
 *
 * @example
 * const compiled = createQuery("$filter=Size eq 4 and Age gt 18", { alias: "user", useParameters: true });
 * // compiled.where, compiled.parameters — для подстановки в QueryBuilder
 */
export function createQuery(odataQuery: string | Token, options: SqlOptions): TypeOrmVisitor {
  options.type = SQLLang.Oracle;

  const visitor = new TypeOrmVisitor(options);
  // Строка парсится в дерево токенов; если передан Token — повторный разбор не нужен.
  const ast: Token = <Token>(typeof odataQuery == 'string' ? query(odataQuery) : odataQuery);
  const visit = visitor.Visit(ast);
  const type = visit.asType();

  return type;
}
