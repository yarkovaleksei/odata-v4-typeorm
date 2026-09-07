/**
 * @file Экранирование идентификаторов SQL по правилам драйвера.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ. Три места собирают SQL руками, мимо QueryBuilder, — подзапрос
 * по связи (`relationSource`), окно вложенной пагинации (`nestedPageCondition`) и условия
 * `$search` (`processSearch`). Каждому нужно одно и то же: превратить имя таблицы или колонки
 * в кавычки, принятые у текущего драйвера. Раньше каждое место заводило собственное
 * `const escape = (name) => connection.driver.escape(name)` — одиннадцать одинаковых замыканий, —
 * а `escapeTablePath` существовал в двух дословных копиях.
 *
 * Дословная копия здесь опаснее, чем кажется: `tablePath` со схемой (`public.book`) обязан
 * экранироваться посегментно, и стоит одной из копий отстать, как в SQL появится одно имя
 * `"public.book"` — синтаксически корректное, но указывающее в никуда.
 */
import type { DataSource } from 'typeorm';

/**
 * Функция экранирования идентификаторов для конкретного подключения.
 *
 * Замыкание, а не прямой вызов `connection.driver.escape` по месту: имя `escape` читается
 * в шаблонных строках заметно лучше, а вызовов на один собираемый фрагмент SQL приходится
 * до десятка.
 *
 * @example
 * const escape = createEscape(connection);
 *
 * `${escape(alias)}.${escape(column.databaseName)}`; // '"Author"."id"'
 */
export function createEscape(connection: DataSource): (name: string) => string {
  return (name: string) => connection.driver.escape(name);
}

/**
 * Имя таблицы с учётом схемы: `public.book` экранируется посегментно.
 *
 * Экранировать `tablePath` целиком нельзя — получилось бы одно имя `"public.book"`,
 * то есть ссылка на таблицу с точкой в названии, а не на таблицу `book` в схеме `public`.
 */
export function escapeTablePath(connection: DataSource, tablePath: string): string {
  return tablePath
    .split('.')
    .map((segment) => connection.driver.escape(segment))
    .join('.');
}
