/**
 * @file Доводка сборки в модули ES: расширения в импортах и признак формата (R-20).
 *
 * ЗАЧЕМ. `tsc` не дописывает расширения в пути импортов — он оставляет их ровно такими,
 * как в исходнике. Для CommonJS это неважно: `require('./dialect')` найдёт и файл, и каталог
 * с `index.js`. В модулях ES так нельзя — Node требует полный путь с расширением, иначе
 * `ERR_MODULE_NOT_FOUND` на первом же импорте.
 *
 * ПОЧЕМУ НЕ РАСШИРЕНИЯ В ИСХОДНИКАХ. Канонический способ — писать `from './dialect/index.js'`
 * прямо в TypeScript. Он потребовал бы правки каждого импорта в полусотне файлов и отдельного
 * `moduleNameMapper` в Jest: под ts-jest путь резолвится по файловой системе, где лежит
 * `index.ts`, а не `index.js`. Цена — постоянная и на каждом файле; выгода — одна и та же.
 * Здесь она вынесена в один шаг сборки: исходники остаются обычными, а расширения
 * появляются там, где нужны, — в готовых модулях ES.
 *
 * ПРОВЕРКА. Регулярное выражение по готовому JS выглядит хрупко, поэтому шаг не верит себе
 * на слово: путь, для которого на диске нет ни файла, ни каталога с `index.js`, роняет сборку.
 * Плюс `yarn build:check` действительно загружает оба формата пакета настоящим Node —
 * без такой проверки поломка обнаружилась бы уже у пользователя.
 */

import * as fs from 'fs';
import * as path from 'path';

const repositoryRoot = path.resolve(__dirname, '..');
const esmRoot = path.join(repositoryRoot, 'build/esm');

/**
 * Пути в `from '…'`, `import('…')` и `export … from '…'`.
 *
 * Кавычки в готовом коде всегда двойные (так печатает `tsc`), но одинарные допускаются
 * на случай смены настроек эмиттера.
 */
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"]+)\2/g;

/**
 * Имя пакета в пути вида `odata-v4-sql/lib/visitor` — с учётом области (`@scope/pkg/sub`).
 *
 * Нужно, чтобы отличить импорт корня пакета (трогать нельзя: его разрешает карта `exports`
 * или поле `main`) от импорта файла внутри пакета — вот ему расширение и требуется.
 */
const PACKAGE_SUBPATH = /^(@[^/]+\/[^/]+|[^@][^/]*)\/(.+)$/;

/**
 * Дописывает расширение к одному пути.
 *
 * Правил три, и они отличаются тем, кто разрешает путь:
 *
 * 1. Относительный путь резолвится по файловой системе сборки.
 * 2. Путь внутрь чужого пакета (`odata-v4-sql/lib/visitor`) — тоже файл, только в
 *    `node_modules`; в модулях ES он так же обязан быть с расширением. Разрешается через
 *    `require.resolve`, чтобы не гадать про `index.js` и вложенные каталоги.
 * 3. Корень пакета (`typeorm`, `odata-v4-literal`) остаётся как есть: его разрешает сам Node
 *    по карте `exports` или полю `main`, и дописанный путь сломал бы это разрешение.
 *
 * @param fromFile - файл, в котором встретился импорт: путь резолвится относительно него.
 * @param specifier - путь как он записан в исходнике.
 * @returns путь с расширением.
 *
 * @throws {Error} если путь не разрешается ни во что.
 */
function resolveSpecifier(fromFile: string, specifier: string): string {
  // Уже с расширением — оставляем как есть.
  if (specifier.endsWith('.js') || specifier.endsWith('.json')) {
    return specifier;
  }

  const directory = path.dirname(fromFile);

  if (specifier.startsWith('.')) {
    const target = path.resolve(directory, specifier);

    if (fs.existsSync(`${target}.js`)) {
      return `${specifier}.js`;
    }

    if (fs.existsSync(path.join(target, 'index.js'))) {
      return `${specifier}/index.js`;
    }

    throw new Error(
      `не удалось разрешить импорт "${specifier}" из ${path.relative(repositoryRoot, fromFile)}`
    );
  }

  if (!PACKAGE_SUBPATH.test(specifier)) {
    return specifier;
  }

  // Резолвим от корня репозитория: в сборке своего `node_modules` нет.
  const resolved = require.resolve(specifier, { paths: [repositoryRoot] });
  const marker = `${path.sep}node_modules${path.sep}`;
  const position = resolved.lastIndexOf(marker);

  if (position === -1) {
    throw new Error(`импорт "${specifier}" разрешился мимо node_modules: ${resolved}`);
  }

  return resolved
    .slice(position + marker.length)
    .split(path.sep)
    .join('/');
}

/** Проставляет расширения во всех импортах одного файла. */
function rewriteFile(file: string): number {
  const source = fs.readFileSync(file, 'utf8');
  let rewritten = 0;

  const result = source.replace(
    SPECIFIER,
    (_match: string, keyword: string, quote: string, specifier: string) => {
      const resolved = resolveSpecifier(file, specifier);

      if (resolved !== specifier) {
        rewritten += 1;
      }

      return `${keyword}${quote}${resolved}${quote}`;
    }
  );

  if (result !== source) {
    fs.writeFileSync(file, result);
  }

  return rewritten;
}

/** Файлы сборки, в которых бывают импорты: сам код и объявления типов. */
function listSources(directory: string): string[] {
  const found: string[] = [];

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      found.push(...listSources(absolutePath));
      continue;
    }

    if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.d.ts'))) {
      found.push(absolutePath);
    }
  }

  return found;
}

function main(): void {
  if (!fs.existsSync(esmRoot)) {
    throw new Error(`нет каталога ${esmRoot}: сначала выполните tsc --project tsconfig.esm.json`);
  }

  const files = listSources(esmRoot);
  const rewritten = files.reduce((total, file) => total + rewriteFile(file), 0);

  /**
   * Признак формата для Node.
   *
   * Расширение `.js` внутри пакета с `"type": "commonjs"` (умолчание) означает CommonJS,
   * поэтому одних лишь `import` в коде мало — Node прочитает файл как CommonJS и споткнётся
   * о синтаксис. Вложенный `package.json` переопределяет формат для всего каталога,
   * не трогая формат остального пакета.
   */
  fs.writeFileSync(
    path.join(esmRoot, 'package.json'),
    `${JSON.stringify({ type: 'module' }, null, 2)}\n`
  );

  console.log(`Сборка ES: ${files.length} файлов, расширения проставлены в ${rewritten} импортах.`);
}

main();
