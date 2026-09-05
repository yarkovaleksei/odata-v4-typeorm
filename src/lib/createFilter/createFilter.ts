/**
 * @file Компиляция одного выражения `$filter` (без остальных query options) в тот же формат,
 * что и `createQuery`.
 *
 * Разница с `createQuery` — только в точке входа парсера: здесь используется `filter()`, который ждёт
 * голое булево выражение (`name eq 'Ann'`), а не строку query options (`$filter=name eq 'Ann'`).
 * Всё остальное — тот же `TypeOrmVisitor`, тот же `asType()`, тот же формат результата.
 */
import { filter } from 'odata-v4-parser';
import type { Token } from 'odata-v4-parser/lib/lexer';
import { SQLLang } from 'odata-v4-sql';

import { TypeOrmVisitor } from '../TypeOrmVisitor';
import type { SqlOptions } from '../types';

/**
 * Строит объект `TypeOrmVisitor` с заполненным `where` (и связанными полями) из OData filter.
 *
 * Основной сценарий — «сырой» SQL мимо TypeORM: получить `where` + `parameters` и подставить их
 * в собственный запрос (см. `src/example/sql.ts`). Для TypeORM удобнее `executeQuery`.
 *
 * @param odataFilter - голое выражение фильтра (без префикса `$filter=`) или готовый AST.
 * @param options - опции SQL-генерации; `alias` задаёт префикс колонок. Передайте `''`,
 *   если префикс не нужен (запрос к одной таблице без алиаса).
 * @returns посетитель после полного обхода AST и `asType()`.
 *
 * @remarks Мутирует переданный объект `options` (проставляет `type`).
 * @throws {Error} `Error: Fail at <позиция>` из `odata-v4-parser` на некорректном выражении.
 *
 * @example
 * // GET /api/Users?$filter=Id eq 42
 * const compiled = createFilter(req.query.$filter, { alias: '' });
 *
 * compiled.where;      // 'Id = :p0'
 * compiled.parameters; // Map { 'p0' => 42 }
 */
export function createFilter(odataFilter: string | Token, options: SqlOptions): TypeOrmVisitor {
  options.type = SQLLang.Oracle;

  const visitor = new TypeOrmVisitor(options);
  const ast: Token = <Token>(typeof odataFilter == 'string' ? filter(odataFilter) : odataFilter);
  const visit = visitor.Visit(ast);
  const type = visit.asType();

  return type;
}
