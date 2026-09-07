/**
 * @file Проверка документации: ссылки, якоря и примеры кода (R-30).
 *
 * ЗАЧЕМ. Документация здесь — часть контракта, а не приложение к коду: матрица поддержки
 * OData, справочник API и рецепты описывают то, на что пользователь опирается, не заглядывая
 * в исходники. Гниёт она молча: файл переименовали — ссылка ведёт в никуда, экспорт убрали —
 * пример перестал компилироваться, скрипт из `package.json` исчез — команда из README не
 * запускается. Ни один из этих случаев не ловится ни тестами, ни линтером.
 *
 * ЧТО ПРОВЕРЯЕТСЯ.
 * 1. Относительные ссылки указывают на существующие файлы и каталоги.
 * 2. Якоря (`#заголовок`, в том числе с указанием файла) существуют в целевом документе.
 *    Слаг считается по правилам GitHub, включая нумерацию повторяющихся заголовков.
 * 3. Примеры на TypeScript и JavaScript разбираются компилятором без синтаксических ошибок,
 *    а имена, импортируемые из самого пакета, действительно им экспортируются.
 * 4. Команды `yarn …` в примерах существуют среди скриптов `package.json`.
 *    Блоки JSON разбираются как JSON.
 *
 * ЧЕГО ПРОВЕРКА НЕ ДЕЛАЕТ И ПОЧЕМУ.
 * Внешние ссылки (`http://…`) не проверяются: сеть в CI сделала бы проверку мигающей, а падение
 * сборки из-за чужого сайта, лежащего десять минут, обесценивает саму проверку.
 * Примеры не проходят полный тайпчек: почти все они — фрагменты, где `repo`, `req` и `dataSource`
 * приходят из окружающего текста. Обвязка, достаточная для тайпчека, переписала бы примеры
 * ради инструмента, а не ради читателя. Проверяются поэтому синтаксис и имена — то есть ровно
 * тот класс ошибок, который возникает при правках кода, а не при написании самих примеров.
 */

import * as fs from 'fs';
import * as path from 'path';

import * as ts from 'typescript';

const repositoryRoot = path.resolve(__dirname, '..');

/** Каталоги без документации: результаты сборки, зависимости и служебные данные. */
const skippedDirectories = new Set(['node_modules', 'build', 'coverage', 'dist', '.git']);

/**
 * Встроенные команды yarn. Всё остальное после `yarn` обязано быть скриптом из `package.json`:
 * именно ссылки на исчезнувшие скрипты и составляют здесь основной класс ошибок.
 */
const yarnBuiltins = new Set([
  'add',
  'audit',
  'cache',
  'dlx',
  'global',
  'info',
  'init',
  'install',
  'link',
  'list',
  'outdated',
  'pack',
  'publish',
  'remove',
  'run',
  'upgrade',
  'upgrade-interactive',
  'why',
  'workspace',
  'workspaces',
]);

interface Problem {
  file: string;
  line: number;
  message: string;
}

interface CodeBlock {
  lang: string;
  code: string;
  /** Номер строки открывающей ограды, 1-based. */
  line: number;
}

interface Document {
  /** Путь от корня репозитория — в таком виде он и попадает в отчёт. */
  file: string;
  absolutePath: string;
  /**
   * Строки документа, где содержимое огороженных блоков заменено пустыми строками.
   * Нумерация при этом сохраняется, а `# комментарий` внутри блока `bash` не принимается
   * за заголовок и `[ссылка](…)` внутри примера markdown не проверяется.
   */
  prose: string[];
  blocks: CodeBlock[];
}

function listMarkdownFiles(directory: string): string[] {
  const found: string[] = [];

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) {
        found.push(...listMarkdownFiles(absolutePath));
      }
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.md')) {
      found.push(absolutePath);
    }
  }

  return found;
}

function readDocument(absolutePath: string): Document {
  const lines = fs.readFileSync(absolutePath, 'utf8').split('\n');
  const prose: string[] = [];
  const blocks: CodeBlock[] = [];

  let openFence: { lang: string; line: number; code: string[] } | null = null;

  lines.forEach((line, index) => {
    const fence = /^\s*```(\S*)\s*$/.exec(line);

    if (openFence === null) {
      if (fence) {
        openFence = { lang: fence[1] ?? '', line: index + 1, code: [] };
      }
      prose.push(fence ? '' : line);
      return;
    }

    // Закрывающая ограда — это ``` без языка; ``` с языком внутри блока быть не может.
    if (fence && (fence[1] ?? '') === '') {
      blocks.push({ lang: openFence.lang, code: openFence.code.join('\n'), line: openFence.line });
      openFence = null;
    } else {
      openFence.code.push(line);
    }

    prose.push('');
  });

  return {
    file: path.relative(repositoryRoot, absolutePath),
    absolutePath,
    prose,
    blocks,
  };
}

/**
 * Слаг заголовка по правилам GitHub: разметка снимается, регистр опускается, пунктуация
 * выбрасывается, пробелы становятся дефисами. Кириллица сохраняется как есть — именно поэтому
 * здесь нужны unicode-классы, а не привычный `[a-z0-9]`.
 */
function slugify(headingText: string): string {
  return headingText
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*~]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
    .replace(/\s+/g, '-');
}

/** Якоря документа. Повторяющиеся заголовки GitHub нумерует: `-1`, `-2` и так далее. */
function collectAnchors(document: Document): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();

  for (const line of document.prose) {
    const heading = /^#{1,6}\s+(.*\S)\s*$/.exec(line);
    if (!heading) {
      continue;
    }

    const base = slugify(heading[1] ?? '');
    if (base === '') {
      continue;
    }

    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }

  return anchors;
}

function checkLinks(document: Document, anchorsByFile: Map<string, Set<string>>): Problem[] {
  const problems: Problem[] = [];

  document.prose.forEach((line, index) => {
    const linkPattern = /\[[^\]]*\]\(([^)\s]+)\)/g;
    let match: RegExpExecArray | null;

    while ((match = linkPattern.exec(line)) !== null) {
      const target = match[1] ?? '';

      // Внешние адреса и якоря протоколов не наше дело — см. шапку файла.
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
        continue;
      }

      const hashAt = target.indexOf('#');
      const filePart = hashAt === -1 ? target : target.slice(0, hashAt);
      const anchor = hashAt === -1 ? '' : decodeURIComponent(target.slice(hashAt + 1));
      const line1Based = index + 1;

      let targetPath = document.absolutePath;

      if (filePart !== '') {
        targetPath = path.resolve(
          path.dirname(document.absolutePath),
          decodeURIComponent(filePart)
        );

        if (!fs.existsSync(targetPath)) {
          problems.push({
            file: document.file,
            line: line1Based,
            message: `ссылка ведёт в никуда: ${target}`,
          });
          continue;
        }
      }

      if (anchor === '') {
        continue;
      }

      const anchors = anchorsByFile.get(targetPath);

      // Якорь в не-markdown файле проверить нечем: там нет заголовков.
      if (!anchors) {
        continue;
      }

      if (!anchors.has(anchor)) {
        problems.push({
          file: document.file,
          line: line1Based,
          message: `якоря нет в целевом документе: ${target}`,
        });
      }
    }
  });

  return problems;
}

/**
 * Синтаксическая проверка примера. Часть примеров — фрагменты (элемент массива, объект
 * из середины таблицы данных), поэтому при неудаче код пробуется ещё раз как содержимое
 * массива: так фрагмент становится корректной программой, а настоящая ошибка синтаксиса
 * остаётся ошибкой в обоих случаях.
 */
function parseErrors(code: string): readonly ts.Diagnostic[] {
  const parse = (source: string): readonly ts.Diagnostic[] => {
    const sourceFile = ts.createSourceFile(
      'example.ts',
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );

    // `parseDiagnostics` не входит в публичный тип `SourceFile`, но это единственный способ
    // получить ошибки разбора без создания программы: полноценный `Program` на каждый пример
    // превратил бы проверку документации в минутную.
    return (
      (sourceFile as ts.SourceFile & { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? []
    );
  };

  const direct = parse(code);
  if (direct.length === 0) {
    return direct;
  }

  return parse(`[\n${code}\n]`).length === 0 ? [] : direct;
}

/** Имена, импортируемые из самого пакета: их существование и есть предмет проверки. */
function importedNames(code: string, packageName: string): { name: string; line: number }[] {
  const sourceFile = ts.createSourceFile(
    'example.ts',
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  const names: { name: string; line: number }[] = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }

    if (statement.moduleSpecifier.text !== packageName) {
      continue;
    }

    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) {
      continue;
    }

    for (const element of bindings.elements) {
      names.push({
        name: (element.propertyName ?? element.name).text,
        line: sourceFile.getLineAndCharacterOfPosition(element.getStart(sourceFile)).line,
      });
    }
  }

  return names;
}

/** Публичный API пакета — то, что реально реэкспортирует `src/lib/index.ts`. */
function publicApi(): Set<string> {
  const entry = path.join(repositoryRoot, 'src/lib/index.ts');
  const program = ts.createProgram([entry], {
    target: ts.ScriptTarget.ES2018,
    module: ts.ModuleKind.CommonJS,
    experimentalDecorators: true,
    skipLibCheck: true,
    noEmit: true,
  });

  const sourceFile = program.getSourceFile(entry);
  if (!sourceFile) {
    throw new Error(`не удалось прочитать точку входа пакета: ${entry}`);
  }

  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) {
    throw new Error(`точка входа ${entry} не является модулем`);
  }

  return new Set(checker.getExportsOfModule(moduleSymbol).map((symbol) => symbol.getName()));
}

function checkCodeBlocks(
  document: Document,
  packageName: string,
  exportedNames: Set<string>,
  scripts: Set<string>
): Problem[] {
  const problems: Problem[] = [];

  for (const block of document.blocks) {
    if (block.lang === 'ts' || block.lang === 'js') {
      for (const diagnostic of parseErrors(block.code)) {
        problems.push({
          file: document.file,
          line: block.line,
          message: `синтаксис примера: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`,
        });
      }

      for (const imported of importedNames(block.code, packageName)) {
        if (!exportedNames.has(imported.name)) {
          problems.push({
            file: document.file,
            // +1 за строку самой ограды, ещё +1 — переход к 1-based нумерации.
            line: block.line + imported.line + 1,
            message: `пакет не экспортирует \`${imported.name}\``,
          });
        }
      }
    }

    if (block.lang === 'json') {
      try {
        JSON.parse(block.code);
      } catch {
        // Часть блоков — фрагменты объекта (`"files": [...]`), самостоятельным JSON они не
        // являются; корректными их делает обрамление фигурными скобками.
        try {
          JSON.parse(`{${block.code}}`);
        } catch (error) {
          problems.push({
            file: document.file,
            line: block.line,
            message: `блок JSON не разбирается: ${(error as Error).message}`,
          });
        }
      }
    }

    if (block.lang === 'bash') {
      block.code.split('\n').forEach((line, index) => {
        const command = /(?:^|[\s|&;(])yarn\s+(--\S+\s+)*([\w:.-]+)/.exec(line);
        if (!command) {
          return;
        }

        const name = command[2] ?? '';
        if (scripts.has(name) || yarnBuiltins.has(name)) {
          return;
        }

        problems.push({
          file: document.file,
          line: block.line + index + 1,
          message: `в package.json нет скрипта \`${name}\` (команда: yarn ${name})`,
        });
      });
    }
  }

  return problems;
}

function main(): void {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')
  ) as { name: string; scripts?: Record<string, string> };

  const documents = listMarkdownFiles(repositoryRoot).map(readDocument);
  const anchorsByFile = new Map<string, Set<string>>(
    documents.map((document) => [document.absolutePath, collectAnchors(document)])
  );

  const exportedNames = publicApi();
  const scripts = new Set(Object.keys(packageJson.scripts ?? {}));

  const problems: Problem[] = [];
  for (const document of documents) {
    problems.push(...checkLinks(document, anchorsByFile));
    problems.push(...checkCodeBlocks(document, packageJson.name, exportedNames, scripts));
  }

  const blockCount = documents.reduce((total, document) => total + document.blocks.length, 0);

  if (problems.length === 0) {
    console.log(
      `Документация в порядке: ${documents.length} файлов, ${blockCount} примеров кода, ` +
        `ссылки и якоря разрешаются.`
    );
    return;
  }

  problems.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  for (const problem of problems) {
    console.error(`${problem.file}:${problem.line}  ${problem.message}`);
  }
  console.error(`\nПроблем в документации: ${problems.length}`);

  process.exitCode = 1;
}

main();
