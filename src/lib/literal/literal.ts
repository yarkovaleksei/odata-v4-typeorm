/**
 * @file Приведение литерала OData к значению JavaScript.
 *
 * Раньше этим занимался пакет `odata-v4-literal` (последний релиз — 2016 год). Код перенесён
 * сюда вместе с уходом от неподдерживаемых зависимостей (R-18): пятьдесят строк таблицы
 * соответствий не стоят отдельного пакета, который никто не сопровождает.
 *
 * ЧТО ПОМЕНЯЛОСЬ ПРИ ПЕРЕНОСЕ. `Edm.TimeOfDay` возвращает исходную строку, а не момент
 * времени. В исходном пакете `08:00:00` превращалось в `1970-01-01T08:00:00.000Z`, и сравнивать
 * такое с результатом `TIME(x)` было бессмысленно: все три СУБД отдают оттуда `HH:MM:SS`.
 * Обход этого жил в посетителе; теперь исправление на своём месте — в таблице типов.
 *
 * Незнакомый тип возвращается как есть: так вело себя и прежнее решение, и это правильно —
 * значение уходит в параметр запроса, где приведением займётся драйвер СУБД.
 */

/** Целое число. Знак и `+` перед числом разбирает сам JavaScript. */
function integer(value: string): number {
  return Number(value);
}

/** Дробное число вместе с бесконечностями, которые OData записывает словами. */
function float(value: string): number {
  switch (value) {
    case 'INF':
      return Infinity;
    case '-INF':
      return -Infinity;
    default:
      return Number(value);
  }
}

/**
 * Строковый литерал: снимаются кавычки, удвоенная кавычка становится одинарной,
 * процентные последовательности раскодируются.
 *
 * Раскодирование именно здесь, а не в парсере: до разбора неизвестно, где кончается
 * литерал, а `%26` внутри значения не должен превратиться в разделитель параметров.
 */
function string(value: string): string {
  return decodeURIComponent(value).slice(1, -1).replace(/''/g, "'");
}

/**
 * Длительность `duration'P1DT2H'` в миллисекундах.
 *
 * ЗНАК разбирается отдельной группой. Спецификация (раздел 5.1.1.11.1) разрешает
 * `duration'-PT1H'`, и без этой группы минус просто не попадал в разбор: длительность
 * молча становилась положительной. Пока значение только сравнивали с колонкой, ошибка
 * пряталась за несовпадением; `totalseconds` (R-42) делает её видимой.
 *
 * Лет, месяцев и недель здесь нет намеренно: `Edm.Duration` в OData v4 ограничен днями,
 * часами, минутами и секундами — в отличие от полного ISO 8601.
 */
function duration(value: string): number {
  const match = /(-?)P(?:([0-9]+)D)?T?(?:([0-9]{1,2})H)?(?:([0-9]{1,2})M)?(?:([.0-9]+)S)?/.exec(
    value
  );

  if (!match) {
    throw new Error(`Invalid duration literal: ${value}`);
  }

  const [, sign, days, hours, minutes, seconds] = match;

  const total =
    (Number(days ?? 0) * 24 * 60 * 60 +
      Number(hours ?? 0) * 60 * 60 +
      Number(minutes ?? 0) * 60 +
      Number(seconds ?? 0)) *
    1000;

  return sign === '-' ? -total : total;
}

/** Таблица соответствий: тип EDM → преобразование исходного текста литерала. */
const CONVERTERS: Record<string, (value: string) => unknown> = {
  'Edm.String': string,
  'Edm.Byte': integer,
  'Edm.SByte': integer,
  'Edm.Int16': integer,
  'Edm.Int32': integer,
  'Edm.Int64': integer,
  'Edm.Decimal': float,
  'Edm.Double': float,
  'Edm.Single': float,
  'Edm.Boolean': (value) => {
    switch (value.toLowerCase()) {
      case 'true':
        return true;
      case 'false':
        return false;
      default:
        return undefined;
    }
  },
  'Edm.Guid': (value) => decodeURIComponent(value),
  'Edm.Date': (value) => value,
  'Edm.DateTimeOffset': (value) => new Date(value),
  // Время суток остаётся строкой: SQL-функция TIME() во всех трёх СУБД возвращает `HH:MM:SS`.
  'Edm.TimeOfDay': (value) => value,
  'Edm.Duration': duration,
  null: () => null,
};

/**
 * Приводит литерал OData к значению для привязки параметра.
 *
 * @param type - тип EDM из дерева разбора (`'Edm.String'`, `'Edm.Int64'`, `'null'`).
 * @param value - исходный текст литерала, как он записан в запросе.
 * @returns значение, пригодное для передачи драйверу СУБД.
 *
 * @example
 * convertLiteral('Edm.String', "'it''s'"); // "it's"
 * convertLiteral('Edm.Int64', '42');       // 42
 * convertLiteral('null', 'null');          // null
 */
export function convertLiteral(type: string, value: string): unknown {
  const converter = CONVERTERS[type];

  return converter ? converter(value) : value;
}

/**
 * Приводит литерал к его записи в тексте SQL.
 *
 * Нужен единственному сценарию — `useParameters: false`, когда значения не выносятся
 * в параметры, а инлайнятся в SQL. Строки при этом заключаются в кавычки, а внутренняя
 * кавычка удваивается: без этого инлайн значения был бы прямой инъекцией.
 *
 * @example
 * literalToSql('Edm.String', "'Ada'"); // "'Ada'"
 * literalToSql('null', 'null');        // 'NULL'
 */
export function literalToSql(type: string, value: string): string {
  switch (type) {
    case 'Edm.String':
      return `'${string(value).replace(/'/g, "''")}'`;
    case 'Edm.Guid':
    case 'Edm.Date':
    case 'Edm.TimeOfDay':
      return `'${decodeURIComponent(value)}'`;
    case 'Edm.DateTimeOffset':
      return `'${value.replace('T', ' ').replace('Z', ' ').trim()}'`;
    case 'Edm.Boolean':
      return value.toLowerCase() === 'true' ? '1' : value.toLowerCase() === 'false' ? '0' : 'NULL';
    case 'null':
      return 'NULL';
    default:
      return value;
  }
}
