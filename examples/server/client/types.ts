/**
 * @file Типы, которыми обмениваются модули страницы.
 *
 * Форма `SchemaResource` повторяет ответ `/api/$schema` — его собирает `describeResource`
 * в `server.ts`. Это единственное место, где два конца демо договариваются о формате,
 * поэтому при правке одного нужно править и другой; компилятор здесь не поможет —
 * между ними HTTP.
 */

/** Колонка сущности. */
export interface SchemaField {
  name: string;
  /** Имя типа в СУБД (`varchar`, `integer`) — показывается в подсказке. */
  type: string;
  /** Тот же тип, что уходит в `$metadata`: `Edm.String`, `Edm.Int32`, … */
  edmType: string;
  nullable: boolean;
}

/** Связь сущности. */
export interface SchemaRelation {
  name: string;
  /** Имя класса целевой сущности; по нему она ищется в схеме. */
  target: string;
  /** `true` для «один ко многим» и «многие ко многим». */
  collection: boolean;
}

/** Описание одного ресурса: то, что отдаёт `/api/$schema`. */
export interface SchemaResource {
  /** Сегмент маршрута: `books` в `/api/books`. */
  name: string;
  /** Имя класса сущности: `Book`. */
  alias: string;
  fields: SchemaField[];
  relations: SchemaRelation[];
}

/** Строка ответа сервера. Точнее её описать нельзя — состав зависит от запроса. */
export type Row = Record<string, unknown>;

/** Параметры OData в том виде, в каком они кладутся в форму и в URL. */
export interface QueryDraft {
  $filter?: string;
  $select?: string;
  $expand?: string;
  $orderby?: string;
  $top?: string;
  $skip?: string;
  $search?: string;
  $count?: string;
}

/** Готовый пример запроса. */
export interface Example {
  title: string;
  query: QueryDraft;
  /** `true`, если пример существует ради демонстрации отказа с кодом 400. */
  expectError?: boolean;
}
