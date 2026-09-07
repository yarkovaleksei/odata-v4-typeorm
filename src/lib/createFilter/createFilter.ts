/**
 * @file Компиляция одного выражения `$filter` (без остальных query options) в тот же формат,
 * что и `createQuery`.
 *
 * Разница с `createQuery` — только в точке входа парсера: здесь используется `parseFilter`,
 * который ждёт голое булево выражение (`name eq 'Ann'`), а не строку query options
 * (`$filter=name eq 'Ann'`). Всё остальное — тот же `TypeOrmVisitor` и тот же формат результата.
 */
import { parseFilter, parseOrThrow, type Token } from '../odataParser';
import { TypeOrmVisitor } from '../TypeOrmVisitor';
import type { SqlOptions } from '../types';

/**
 * Строит объект `TypeOrmVisitor` с заполненным `where` (и связанными полями) из OData filter.
 *
 * Основной сценарий — «сырой» SQL мимо TypeORM: получить `where` + `parameters` и подставить их
 * в собственный запрос (рецепт с драйвером `pg` — в `docs/recipes.md`, раздел «Без TypeORM:
 * только компиляция в SQL»). Для TypeORM удобнее `executeQuery`.
 *
 * @param odataFilter - голое выражение фильтра (без префикса `$filter=`) или готовый AST.
 * @param options - опции SQL-генерации; `alias` задаёт префикс колонок. Передайте `''`,
 *   если префикс не нужен (запрос к одной таблице без алиаса).
 * @returns посетитель после полного обхода AST — готовый к использованию, никаких
 *   дополнительных вызовов не требуется.
 *
 * @remarks Переданный объект `options` не мутируется: конструктор посетителя работает с копией.
 * @throws {ODataParseError} выражение синтаксически некорректно.
 * @throws {ODataUnsupportedError} выражение разобрано, но содержит конструкцию без трансляции в SQL.
 *
 * @example
 * // GET /api/Users?$filter=Id eq 42
 * const compiled = createFilter(req.query.$filter, { alias: '' });
 *
 * compiled.where;      // 'Id = :p0'
 * compiled.parameters; // Map { 'p0' => 42 }
 */
export function createFilter(odataFilter: string | Token, options: SqlOptions): TypeOrmVisitor {
  const visitor = new TypeOrmVisitor(options);
  const ast: Token =
    typeof odataFilter === 'string' ? parseOrThrow(odataFilter, parseFilter) : odataFilter;

  return visitor.Visit(ast);
}
