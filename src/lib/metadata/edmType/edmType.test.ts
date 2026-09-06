/**
 * @file Тесты соответствия типов колонок TypeORM типам EDM.
 *
 * Проверяется не «таблица совпадает с таблицей» (это тавтология), а три решения,
 * которые в ней приняты и могут быть нарушены случайной правкой:
 *
 * 1. тип, заданный конструктором, разбирается наравне со строковым;
 * 2. незнакомый тип даёт `Edm.String`, а не ломает генерацию документа;
 * 3. уточнение длины в имени типа (`varchar(255)`) отсекается.
 */
import type { ColumnMetadata } from '../types';
import { FALLBACK_EDM_TYPE, resolveEdmType } from './edmType';

/**
 * Колонка, у которой для этих тестов значим один лишь тип.
 *
 * Параметр объявлен как `unknown`, а не `ColumnType`: половина проверок в том и состоит,
 * что в поле приходит значение вне этого объединения — имя типа с уточнением длины
 * либо конструктор пользовательского класса.
 */
const column = (type: unknown): ColumnMetadata => ({ type }) as unknown as ColumnMetadata;

describe('resolveEdmType', () => {
  describe('типы, заданные строкой', () => {
    it.each([
      ['varchar', 'Edm.String'],
      ['text', 'Edm.String'],
      ['jsonb', 'Edm.String'],
      ['enum', 'Edm.String'],
      ['uuid', 'Edm.Guid'],
      ['smallint', 'Edm.Int16'],
      ['integer', 'Edm.Int32'],
      ['int4', 'Edm.Int32'],
      ['bigint', 'Edm.Int64'],
      ['tinyint', 'Edm.Byte'],
      ['decimal', 'Edm.Decimal'],
      ['numeric', 'Edm.Decimal'],
      ['money', 'Edm.Decimal'],
      ['boolean', 'Edm.Boolean'],
      ['date', 'Edm.Date'],
      ['time', 'Edm.TimeOfDay'],
      ['datetime', 'Edm.DateTimeOffset'],
      ['timestamptz', 'Edm.DateTimeOffset'],
      ['timestamp with time zone', 'Edm.DateTimeOffset'],
      ['interval', 'Edm.Duration'],
      ['bytea', 'Edm.Binary'],
      ['blob', 'Edm.Binary'],
    ])('%s → %s', (type, expected) => {
      expect(resolveEdmType(column(type))).toBe(expected);
    });

    it('регистр имени типа не важен', () => {
      expect(resolveEdmType(column('VARCHAR'))).toBe('Edm.String');
      expect(resolveEdmType(column('BigInt'))).toBe('Edm.Int64');
    });

    it('уточнение длины и точности в имени типа отсекается', () => {
      // Длина и точность описываются отдельными атрибутами CSDL (MaxLength, Precision),
      // поэтому в имени типа они мешают.
      expect(resolveEdmType(column('varchar(255)'))).toBe('Edm.String');
      expect(resolveEdmType(column('decimal(10, 2)'))).toBe('Edm.Decimal');
    });
  });

  describe('типы, заданные конструктором', () => {
    it.each([
      [String, 'Edm.String'],
      [Boolean, 'Edm.Boolean'],
      [Date, 'Edm.DateTimeOffset'],
    ])('%p → %s', (type, expected) => {
      expect(resolveEdmType(column(type))).toBe(expected);
    });

    it('Number даёт Edm.Int32', () => {
      // Не Edm.Double: для `@Column()` над полем `number` сам TypeORM создаёт целочисленную
      // колонку, и дробное значение туда не поместится независимо от типа в TypeScript.
      expect(resolveEdmType(column(Number))).toBe('Edm.Int32');
    });
  });

  describe('приближённые дробные приводятся к Edm.Double', () => {
    it.each(['float', 'float4', 'float8', 'real', 'double precision'])('%s', (type) => {
      // Объявить хранилище точнее, чем оно есть, безопасно: клиент не потеряет значение.
      // Обратное направление обещало бы меньшую точность, чем приходит на самом деле.
      expect(resolveEdmType(column(type))).toBe('Edm.Double');
    });
  });

  describe('незнакомый тип', () => {
    it.each(['ltree', 'hstore', 'geometry', 'tsvector'])('%s даёт запасной тип', (type) => {
      // Падать нельзя: набор типов у каждой СУБД открыт (домены, расширения), и одна
      // экзотическая колонка не должна лишать клиента всего документа.
      expect(resolveEdmType(column(type))).toBe(FALLBACK_EDM_TYPE);
    });

    it('тип неизвестного конструктора даёт запасной тип', () => {
      class Money {}

      expect(resolveEdmType(column(Money))).toBe(FALLBACK_EDM_TYPE);
    });
  });
});
