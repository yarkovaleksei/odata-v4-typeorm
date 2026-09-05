/**
 * Реализация клиентского параметра `$search` на уровне SQL TypeORM.
 *
 * По метаданным сущности собираются текстовые колонки (LIKE по подстроке, регистронезависимо)
 * и числовые (точное равенство, только если строка поиска успешно приводится к числу через `Number`).
 * Условия объединяются через `OR` внутри одной группы `Brackets`, затем добавляются как `andWhere`,
 * чтобы сочетаться с остальными фильтрами запроса.
 */
import type { EntityMetadata, ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import { Brackets } from 'typeorm';
import type { QueryParams } from '../../types';

/**
 * Имена типов колонок TypeORM/БД, для которых допустим поиск подстроки через `LIKE`.
 */
export const searchableTextColumnTypes = [
  'varchar',
  'character varying',
  'char',
  'character',
  'text',
  'citext',
  'nvarchar',
  'nchar',
  'ntext',
  'tinytext',
  'mediumtext',
  'longtext',
  // SQLite column.type is String
  'string',
];

/**
 * Числовые типы столбцов, поддерживающие поиск по принципу точного равенства
 */
export const searchableNumberColumnTypes = [
  'int',
  'int2',
  'int4',
  'int8',
  'smallint',
  'integer',
  'bigint',
  'decimal',
  'numeric',
  'float',
  'float4',
  'float8',
  'double',
  'double precision',
  'real',
  // SQLite
  'number',
] as const;

export type SearchableTextColumnType = (typeof searchableTextColumnTypes)[number];
export type SearchableNumberColumnType = (typeof searchableNumberColumnTypes)[number];

/**
 * Добавляет к `queryBuilder` условия поиска по всем подходящим скалярным колонкам корневой сущности.
 *
 * @param metadata - метаданные корневой сущности (список колонок и их типов).
 * @param $search - строка поиска (уже может быть обрезана снаружи; пустая — ранний выход).
 * @param alias - SQL-алиас корневой таблицы в запросе.
 */
export const processSearch = <T extends ObjectLiteral = ObjectLiteral>(
  queryBuilder: SelectQueryBuilder<T>,
  metadata: EntityMetadata,
  $search: Required<QueryParams>['$search'],
  alias: string
) => {
  if (!$search || $search.trim() === '') {
    return;
  }

  const searchValue = $search.trim();

  const textColumns: string[] = [];
  const numberColumns: string[] = [];

  for (const column of metadata.columns) {
    const type = typeof column.type === 'function' ? column.type.name : column.type;
    const typeLower: SearchableTextColumnType | SearchableNumberColumnType = type?.toLowerCase();

    if (searchableTextColumnTypes.includes(typeLower as SearchableTextColumnType)) {
      textColumns.push(column.propertyName);
    } else if (searchableNumberColumnTypes.includes(typeLower as SearchableNumberColumnType)) {
      numberColumns.push(column.propertyName);
    }
  }

  const conditions: string[] = [];
  const parameters: Record<string, string | number> = {};

  // Текстовые условия
  if (textColumns.length) {
    parameters.textSearchValue = `%${searchValue.toLowerCase()}%`;

    textColumns.forEach((column) => {
      conditions.push(`LOWER("${alias}"."${column}") LIKE LOWER(:textSearchValue)`);
    });
  }

  /**
   * Числовые условия (только если $search строка, которую можно привести к числовому типу через Number)
   *
   * @example
   *
   * $search=123 // numericValue = 123
   * $search=123a // numericValue = NaN
   */
  const numericValue = Number(searchValue);

  if (!isNaN(numericValue) && numberColumns.length) {
    parameters.numberSearchValue = numericValue;

    numberColumns.forEach((column) => {
      conditions.push(`"${alias}"."${column}" = :numberSearchValue`);
    });
  }

  // Если есть хотя бы одно условие, группируем через Brackets
  if (conditions.length) {
    queryBuilder.andWhere(
      new Brackets((qb) => {
        conditions.forEach((condition, idx) => {
          if (idx === 0) {
            qb.where(condition);
          } else {
            qb.orWhere(condition);
          }
        });
      }),
      parameters
    );
  }
};
