/**
 * @file Компиляция полной OData query string (или уже разобранного AST) в объект-посетитель TypeORM.
 *
 * Цепочка: строка → `parseQueryOptions` → AST (`Token`) → обход через `TypeOrmVisitor` →
 * результат с полями `where`, `select`, `orderby`, `parameters`, вложенными `includes`
 * для `$expand` и т.д.
 */
import { ODataError, ODataParseError } from '../errors';
import { parseQueryOptions, type Token } from '../odataParser';
import { TypeOrmVisitor } from '../TypeOrmVisitor';
import type { SqlOptions } from '../types';

/**
 * Собирает дескриптор запроса (фрагменты SQL и метаданные) из OData query.
 *
 * Значения по умолчанию для пустого запроса задаёт базовый посетитель: `select === '*'`,
 * `where === '1 = 1'`, `orderby === '1'`. Вызывающий код (`executeQueryByQueryBuilder`,
 * `processIncludes`) опирается на эти «пустые» значения как на признак «опция не задана».
 *
 * @param odataQuery - либо полная строка query options OData (`$filter=…&$top=…`), либо готовый AST.
 * @param options - опции SQL-генерации; обязателен `alias` корневой сущности. Поле `type`
 *   перезаписывается принудительно, передавать его смысла нет.
 * @returns экземпляр `TypeOrmVisitor` после обхода AST и `asType()`.
 *
 * @remarks Мутирует переданный объект `options` (проставляет `type`). Если один и тот же объект
 *   опций переиспользуется между вызовами, это заметно; передавайте литерал.
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
  const ast: Token = typeof odataQuery === 'string' ? parseOrThrow(odataQuery) : odataQuery;

  return visitor.Visit(ast);
}

/**
 * Разбор строки с приведением любой неожиданной ошибки к типизированной.
 *
 * Сам `parseQueryOptions` уже бросает `ODataParseError`; обёртка остаётся страховкой
 * на случай ошибки, которую разбор не предусмотрел, — чтобы HTTP-слой в любом случае мог
 * отличить ошибку клиента от внутреннего сбоя, не разбирая текст сообщения.
 */
function parseOrThrow(odataQuery: string): Token {
  try {
    return parseQueryOptions(odataQuery);
  } catch (e) {
    if (e instanceof ODataError) {
      throw e;
    }

    throw new ODataParseError(odataQuery, e);
  }
}
