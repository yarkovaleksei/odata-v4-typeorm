/**
 * @file Приведение литералов OData к значениям JavaScript и к тексту SQL.
 */
import { convertLiteral, literalToSql } from './literal';

describe('convertLiteral', () => {
  it.each([
    ['Edm.String', "'Ada'", 'Ada'],
    ['Edm.String', "'it''s'", "it's"],
    ['Edm.String', "'a%20b'", 'a b'],
    ['Edm.Int64', '42', 42],
    ['Edm.Int32', '-7', -7],
    ['Edm.Decimal', '3.14', 3.14],
    ['Edm.Double', 'INF', Infinity],
    ['Edm.Double', '-INF', -Infinity],
    ['Edm.Boolean', 'true', true],
    ['Edm.Boolean', 'false', false],
    ['Edm.Guid', '0f8fad5b-d9cb-469f-a165-70867728950e', '0f8fad5b-d9cb-469f-a165-70867728950e'],
    ['Edm.Date', '2020-01-15', '2020-01-15'],
    ['null', 'null', null],
  ])('%s %s', (type, raw, expected) => {
    expect(convertLiteral(type, raw)).toEqual(expected);
  });

  it('дата со смещением превращается в момент времени', () => {
    expect(convertLiteral('Edm.DateTimeOffset', '2020-01-15T10:30:00Z')).toEqual(
      new Date('2020-01-15T10:30:00Z')
    );
  });

  /**
   * Исходный пакет превращал время суток в момент `1970-01-01T08:00:00.000Z`, и сравнивать
   * такое с результатом `TIME(x)` было бессмысленно: все три СУБД отдают оттуда `HH:MM:SS`.
   */
  it('время суток остаётся строкой', () => {
    expect(convertLiteral('Edm.TimeOfDay', '08:00:00')).toBe('08:00:00');
  });

  it('длительность переводится в миллисекунды', () => {
    expect(convertLiteral('Edm.Duration', "duration'P1DT2H'")).toBe(
      (24 * 60 * 60 + 2 * 60 * 60) * 1000
    );
  });

  it('незнакомый тип возвращается как есть — приведением займётся драйвер СУБД', () => {
    expect(convertLiteral('Edm.Geography', 'что-то')).toBe('что-то');
  });

  it('нераспознанное логическое значение даёт undefined, а не ложь', () => {
    // Иначе `$filter=isActive eq maybe` тихо превратилось бы в поиск неактивных.
    expect(convertLiteral('Edm.Boolean', 'maybe')).toBeUndefined();
  });
});

describe('literalToSql', () => {
  it('строка берётся в кавычки, внутренняя кавычка удваивается', () => {
    expect(literalToSql('Edm.String', "'it''s'")).toBe("'it''s'");
  });

  /**
   * Инлайн значений применяется только при `useParameters: false`, но и там текст должен
   * оставаться корректным SQL: без удвоения кавычки это была бы прямая инъекция.
   */
  it('кавычка из раскодированного значения тоже удваивается', () => {
    expect(literalToSql('Edm.String', "'a%27b'")).toBe("'a''b'");
  });

  it.each([
    ['null', 'null', 'NULL'],
    ['Edm.Boolean', 'true', '1'],
    ['Edm.Boolean', 'false', '0'],
    ['Edm.Date', '2020-01-15', "'2020-01-15'"],
    ['Edm.Int64', '42', '42'],
  ])('%s %s', (type, raw, expected) => {
    expect(literalToSql(type, raw)).toBe(expected);
  });

  it('дата со смещением записывается без T и Z', () => {
    expect(literalToSql('Edm.DateTimeOffset', '2020-01-15T10:30:00Z')).toBe(
      "'2020-01-15 10:30:00'"
    );
  });
});
