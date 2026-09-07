/**
 * @file Компиляция полной OData query string (или уже разобранного AST) в объект-посетитель TypeORM.
 *
 * Цепочка: строка → `parseQueryOptions` → AST (`Token`) → обход через `TypeOrmVisitor` →
 * результат с полями `where`, `select`, `orderby`, `parameters`, вложенными `includes`
 * для `$expand` и т.д.
 */
import { parseOrThrow, parseQueryOptions, type Token } from '../odataParser';
import { TypeOrmVisitor } from '../TypeOrmVisitor';
import type { SqlOptions } from '../types';

/**
 * Собирает дескриптор запроса (фрагменты SQL и метаданные) из OData query.
 *
 * Значения по умолчанию для пустого запроса проставляет посетитель: `select === '*'`,
 * `where === '1 = 1'`, `orderby === '1'` (см. {@link VISITOR_DEFAULTS}). Вызывающий код
 * (`executeQueryByQueryBuilder`, `processIncludes`) опирается на эти «пустые» значения
 * как на признак «опция не задана».
 *
 * @param odataQuery - либо полная строка query options OData (`$filter=…&$top=…`), либо готовый AST.
 * @param options - опции SQL-генерации; обязателен `alias` корневой сущности.
 * @returns экземпляр `TypeOrmVisitor` после полного обхода AST — готовый к использованию,
 *   никаких дополнительных вызовов не требуется.
 *
 * @remarks Переданный объект `options` не мутируется: конструктор посетителя работает с копией.
 * @throws {ODataParseError} строка синтаксически некорректна.
 * @throws {ODataUnsupportedError} строка разобрана, но содержит конструкцию, которую
 *   библиотека не умеет транслировать в SQL.
 *
 * @example
 * const compiled = createQuery("$filter=Size eq 4 and Age gt 18", { alias: 'user' });
 *
 * compiled.where;      // 'user.Size = :p0 AND user.Age > :p1'
 * compiled.parameters; // Map { 'p0' => 4, 'p1' => 18 }
 *
 * queryBuilder.andWhere(compiled.where).setParameters(mapToObject(compiled.parameters));
 */
export function createQuery(odataQuery: string | Token, options: SqlOptions): TypeOrmVisitor {
  const visitor = new TypeOrmVisitor(options);
  // Строка парсится в дерево токенов; если передан Token — повторный разбор не нужен.
  const ast: Token =
    typeof odataQuery === 'string' ? parseOrThrow(odataQuery, parseQueryOptions) : odataQuery;

  return visitor.Visit(ast);
}
