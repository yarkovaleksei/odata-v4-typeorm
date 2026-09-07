/**
 * @file Проверка собранного пакета: оба формата действительно загружаются (R-20).
 *
 * ЗАЧЕМ. Двойная публикация ломается тихо. Карта `exports` может указывать на несуществующий
 * файл, в модулях ES может не хватить расширения в импорте, а именованный экспорт из
 * зависимости на CommonJS может не определиться загрузчиком Node — и всё это проявится
 * только у пользователя, потому что тесты идут через ts-jest и настоящий пакет не грузят.
 *
 * Проверка идёт по имени пакета, а не по пути к файлу: так задействуется та же карта
 * `exports`, по которой пакет будут разрешать потребители (Node умеет ссылаться на пакет
 * по собственному имени изнутри). Оба формата ещё и вызываются: `createFilter` тянет за собой
 * все три зависимости-основания, то есть неудачный импорт из них тоже всплывёт здесь.
 */

import * as path from 'path';

const packageName = 'odata-v4-typeorm-improved';

/** Ожидаемая часть публичного API — по ней видно, что загрузился баррель, а не пустышка. */
const REQUIRED_EXPORTS = [
  'executeQuery',
  'executeQueryByQueryBuilder',
  'ODataQueryMiddleware',
  'ODataMetadataMiddleware',
  'createMetadataDocument',
  'createQuery',
  'createFilter',
  'TypeOrmVisitor',
  'ODataUnsupportedError',
];

/**
 * Динамический импорт, который переживёт компиляцию в CommonJS.
 *
 * Обычный `await import(...)` TypeScript при `module: commonjs` превращает в `require`,
 * и проверка формата ES выродилась бы в повторную проверку CommonJS. `new Function` прячет
 * выражение от компилятора.
 */
const importEsm = new Function('specifier', 'return import(specifier)') as (
  specifier: string
) => Promise<Record<string, unknown>>;

/** Сверяет набор экспортов и заодно выполняет компиляцию простого фильтра. */
function assertUsable(format: string, api: Record<string, unknown>): void {
  const missing = REQUIRED_EXPORTS.filter((name) => typeof api[name] !== 'function');

  if (missing.length) {
    throw new Error(`${format}: в пакете нет экспортов ${missing.join(', ')}`);
  }

  const createFilter = api.createFilter as (
    expression: string,
    options: { alias: string }
  ) => { where: string };

  const compiled = createFilter("name eq 'Ada'", { alias: 'User' });

  if (!compiled.where.includes('User.name')) {
    throw new Error(`${format}: createFilter вернул неожиданный результат: ${compiled.where}`);
  }
}

async function main(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const commonjs = require(packageName) as Record<string, unknown>;

  assertUsable('CommonJS', commonjs);

  const esm = await importEsm(packageName);

  // У модуля ES именованные экспорты лежат на самом объекте модуля.
  assertUsable('ES', esm);

  console.log(
    `Пакет загружается в обоих форматах: ${REQUIRED_EXPORTS.length} экспортов на месте, ` +
      `фильтр компилируется. Проверено по карте exports из ${path.basename('package.json')}.`
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
