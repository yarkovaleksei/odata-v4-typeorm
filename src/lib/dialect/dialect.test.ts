/**
 * @file Приведение драйвера к диалекту и возможности диалекта.
 *
 * Возможности проверяются не ради самих булевых значений, а потому что от них зависит,
 * какой SQL уйдёт в базу: ошибка здесь означает либо синтаксическую ошибку на каждом
 * запросе с вложенным `$top`, либо — что хуже — молча неверную страницу.
 */
import { normalizeDialect, supportsNestedPagePushdown } from './dialect';

describe('normalizeDialect', () => {
  it.each([
    ['postgres', 'postgres'],
    ['aurora-postgres', 'postgres'],
    ['cockroachdb', 'postgres'],
    ['mysql', 'mysql'],
    ['mariadb', 'mysql'],
    ['sqlite', 'sqlite'],
    ['better-sqlite3', 'sqlite'],
    ['sqljs', 'sqlite'],
    ['mssql', 'mssql'],
    ['oracle', 'oracle'],
  ])('%s → %s', (driver, expected) => {
    expect(normalizeDialect(driver)).toBe(expected);
  });

  it('незнакомый драйвер сводится к ansi', () => {
    expect(normalizeDialect('cassandra')).toBe('ansi');
    expect(normalizeDialect(undefined)).toBe('ansi');
  });
});

describe('supportsNestedPagePushdown', () => {
  /**
   * MySQL 8.4 проталкивает внешнее условие внутрь подзапроса до вычисления `ROW_NUMBER()`,
   * и нумерация считается по уже отобранным строкам: `$top` молча перестаёт действовать.
   * Проверено прогоном во всех формах записи. Пока это так, страницу связи на MySQL
   * режет `applyNestedPagination`.
   */
  it('MySQL вычисляет окно неверно', () => {
    expect(supportsNestedPagePushdown('mysql')).toBe(false);
  });

  it('про незнакомый драйвер ничего не известно', () => {
    expect(supportsNestedPagePushdown('ansi')).toBe(false);
  });

  it('остальные диалекты переносят страницу в SQL', () => {
    for (const dialect of ['postgres', 'sqlite', 'mssql', 'oracle'] as const) {
      expect(supportsNestedPagePushdown(dialect)).toBe(true);
    }
  });
});
