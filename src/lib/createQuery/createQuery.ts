/**
 * @file Компиляция полной OData query string (или уже разобранного AST) в объект-посетитель TypeORM.
 *
 * Цепочка: строка → парсер `odata-v4-parser` → AST (`Token`) → обход через `TypeOrmVisitor`
 * (наследник `odata-v4-sql` Visitor) → результат с полями `where`, `select`, `orderby`, `parameters`,
 * вложенными `includes` для `$expand` и т.д.
 *
 * `SQLLang.Oracle` выставляется не ради синтаксиса Oracle, а ради формата плейсхолдеров:
 * именно ветка `asOracleSql()` в базовом посетителе переписывает позиционные `?` в именованные `:pN`,
 * которые умеет связывать TypeORM QueryBuilder. Побочный эффект — Oracle-стиль пагинации
 * (`OFFSET … ROWS FETCH NEXT … ROWS ONLY`) в методе `TypeOrmVisitor.from()`; на сценарий с
 * QueryBuilder он не влияет, потому что там пагинацию делает сам TypeORM.
 */
import { query } from 'odata-v4-parser';
import type { Token } from 'odata-v4-parser/lib/lexer';
import { SQLLang } from 'odata-v4-sql';

import { ODataError, ODataParseError } from '../errors';
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
  options.type = SQLLang.Oracle;

  const visitor = new TypeOrmVisitor(options);
  // Строка парсится в дерево токенов; если передан Token — повторный разбор не нужен.
  const ast: Token = <Token>(typeof odataQuery == 'string' ? parseOrThrow(odataQuery) : odataQuery);
  const visit = visitor.Visit(ast);
  // asType() обязателен: он приводит плейсхолдеры к формату TypeORM (`?` → `:pN`).
  const type = visit.asType();

  return type;
}

/**
 * Разбор строки с приведением ошибки парсера к типизированной.
 *
 * `odata-v4-parser` бросает безымянный `Error` с текстом `Fail at 0`. Оборачиваем его
 * здесь — в единственном месте, где ещё известна исходная строка, — чтобы HTTP-слой мог
 * отличить ошибку клиента от внутреннего сбоя, не разбирая текст сообщения.
 *
 * Ошибки самой библиотеки (`ODataError` из обхода AST) пропускаются как есть: они уже
 * типизированы и несут более точную причину.
 */
function parseOrThrow(odataQuery: string): Token {
  try {
    return query(odataQuery) as Token;
  } catch (e) {
    if (e instanceof ODataError) {
      throw e;
    }

    throw new ODataParseError(odataQuery, e);
  }
}
