/**
 * @file Проверка, что зависимости работают на самой старой поддерживаемой Node.
 *
 * ЗАЧЕМ. Поле `engines` в `package.json` обещает потребителю диапазон версий Node,
 * но выполнить это обещание должны и зависимости: если девелоперская зависимость требует
 * Node 22, то на Node 20 не пройдёт даже установка. Разработчик этого не увидит — у него
 * стоит версия поновее, — а CI упадёт на первой же строке лога:
 *
 * ```
 * error better-sqlite3@13.0.3: The engine "node" is incompatible with this module.
 * Expected version ">=22". Got "20.20.2"
 * ```
 *
 * Именно так и случилось при переходе на TypeORM 1.x: драйвер `sqlite` там удалён, на замену
 * встал `better-sqlite3`, а его последняя мажорная версия отказалась от Node 20. Локально
 * всё поставилось и прошло, потому что на машине была Node 22.
 *
 * ПОЧЕМУ ТОЛЬКО ПРЯМЫЕ ЗАВИСИМОСТИ. Их выбираем мы, и чинится расхождение выбором другой
 * версии. За транзитивные отвечает тот, кто их притащил; проверять их здесь значило бы
 * ловить чужие ошибки, ничего не в силах с ними сделать.
 */

import * as fs from 'fs';
import * as path from 'path';

const repositoryRoot = path.resolve(__dirname, '..');

interface Manifest {
  engines?: { node?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/** Читает манифест пакета; `undefined`, если пакет не установлен. */
function readManifest(directory: string): Manifest | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')) as Manifest;
  } catch {
    return undefined;
  }
}

/**
 * Нижняя граница диапазона `engines.node` — та версия, на которой обязано работать всё.
 *
 * Диапазон разбирается вручную, без semver: он состоит из перечисленных через `||` веток
 * вида `^20.19.0`, `>=24.11.0`, `20.x`, и минимум — это наименьшая из их нижних границ.
 * Тащить ради трёх регулярных выражений зависимость, которой у пакета больше нет,
 * не стоит того.
 */
function lowestVersion(range: string): [number, number, number] | undefined {
  const versions: Array<[number, number, number]> = [];

  for (const match of range.matchAll(/(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/g)) {
    const part = (value: string | undefined): number =>
      value === undefined || value === 'x' || value === '*' ? 0 : Number(value);

    versions.push([Number(match[1]), part(match[2]), part(match[3])]);
  }

  if (versions.length === 0) {
    return undefined;
  }

  return versions.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])[0] as [
    number,
    number,
    number,
  ];
}

/** Допускает ли диапазон указанную версию: достаточно одной подходящей ветки. */
function allows(range: string, version: [number, number, number]): boolean {
  return range.split('||').some((branch) => {
    const bound = lowestVersion(branch);

    if (!bound) {
      return true;
    }

    // Ветка вида `^20.19.0` или `20.x` ограничена сверху своей мажорной версией;
    // `>=24.11.0` — не ограничена.
    const openEnded = /^[\s]*(>=|>)/.test(branch);

    if (!openEnded && bound[0] !== version[0]) {
      return false;
    }

    return (
      version[0] > bound[0] ||
      (version[0] === bound[0] &&
        (version[1] > bound[1] || (version[1] === bound[1] && version[2] >= bound[2])))
    );
  });
}

function main(): void {
  const root = readManifest(repositoryRoot);
  const declared = root?.engines?.node;

  if (!root || !declared) {
    throw new Error('в package.json не объявлено поле engines.node');
  }

  const minimum = lowestVersion(declared);

  if (!minimum) {
    throw new Error(`не удалось разобрать диапазон engines.node: ${declared}`);
  }

  const names = Object.keys({
    ...root.dependencies,
    ...root.devDependencies,
    ...root.peerDependencies,
  });

  const problems: string[] = [];
  let checked = 0;

  for (const name of names) {
    const manifest = readManifest(path.join(repositoryRoot, 'node_modules', name));
    const range = manifest?.engines?.node;

    if (!range) {
      continue;
    }

    checked += 1;

    if (!allows(range, minimum)) {
      problems.push(`${name}: требует node ${range}`);
    }
  }

  const version = minimum.join('.');

  if (problems.length) {
    console.error(
      `Зависимости не работают на самой старой поддерживаемой Node (${version}):\n` +
        problems.map((line) => `  ${line}`).join('\n') +
        `\n\nЛибо возьмите версию пакета, которая её поддерживает, либо сузьте engines.node.`
    );

    process.exitCode = 1;

    return;
  }

  console.log(
    `Зависимости совместимы с самой старой поддерживаемой Node (${version}): ` +
      `проверено ${checked} из ${names.length} прямых (у остальных engines не объявлены).`
  );
}

main();
