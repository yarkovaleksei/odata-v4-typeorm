/**
 * Компиляция только выражения `$filter` (без остальных query options) в тот же формат, что и `createQuery`.
 *
 * Используется парсер `filter` из `odata-v4-parser` вместо `query`, чтобы разбирать короткое
 * выражение сравнений и логики, а не полный набор OData options.
 */
import { filter } from 'odata-v4-parser';
import type { Token } from 'odata-v4-parser/lib/lexer';
import { SQLLang } from 'odata-v4-sql';

import { TypeOrmVisitor } from '../TypeOrmVisitor';
import type { SqlOptions } from '../types';

/**
 * Строит объект `TypeOrmVisitor` с заполненным `where` (и связанными полями) из OData filter.
 *
 * @param odataFilter - строка выражения или готовый AST.
 * @param options - опции SQL-генерации, включая `alias`.
 * @returns посетитель после полного обхода AST.
 *
 * @example
 * const compiled = createFilter("name eq 'Ann'", { alias: "post", useParameters: true });
 */
export function createFilter(odataFilter: string | Token, options: SqlOptions): TypeOrmVisitor {
  options.type = SQLLang.Oracle;

  const visitor = new TypeOrmVisitor(options);
  const ast: Token = <Token>(typeof odataFilter == 'string' ? filter(odataFilter) : odataFilter);
  const visit = visitor.Visit(ast);
  const type = visit.asType();

  return type;
}
