/**
 * @file Разбор выражения `$search` по грамматике OData v4 (раздел 5.1.7).
 *
 * ПОЧЕМУ СВОЙ РАЗБОР. `$search` не проходит через `odata-v4-parser`: тот его грамматику
 * не реализует. Раньше библиотека брала строку целиком и искала её как одну подстроку,
 * то есть `$search=ada OR grace` искал текст «ada OR grace» — молча не то, что просил клиент.
 *
 * ГРАММАТИКА, сведённая к сути (полная — в спецификации, раздел 5.1.7):
 *
 * ```
 * searchExpr := searchAnd ( 'OR' searchAnd )*
 * searchAnd  := searchNot ( ['AND'] searchNot )*      // пробел между словами = AND
 * searchNot  := ['NOT'] searchPrimary
 * searchPrimary := '(' searchExpr ')' | phrase | word
 * ```
 *
 * Приоритет: `NOT` сильнее `AND`, `AND` сильнее `OR`. Соседние слова без оператора
 * соединяются через `AND` — это требование спецификации, а не вольность: `$search=ada lovelace`
 * означает «оба слова», а не «строка целиком».
 *
 * РЕГИСТР ОПЕРАТОРОВ. `AND`, `OR` и `NOT` распознаются только в верхнем регистре — так
 * написано в грамматике. Строчное `and` является обычным словом поиска, и это не придирка:
 * иначе `$search=black and white` нельзя было бы найти как есть.
 *
 * ЧТО ЗДЕСЬ НЕ РЕШАЕТСЯ. Модуль отвечает только за структуру выражения. По каким колонкам
 * искать слово и каким SQL это выражать — дело `processSearch`.
 */
import { ODataInvalidQueryError } from '../../errors';

/**
 * Узел разобранного выражения поиска.
 *
 * `term` — искомый текст: одно слово либо фраза в кавычках. Различать их нужно на уровне
 * компиляции: фраза ищется целиком, включая пробелы.
 */
export type SearchNode =
  | { readonly type: 'term'; readonly value: string; readonly phrase: boolean }
  | { readonly type: 'not'; readonly operand: SearchNode }
  | { readonly type: 'and'; readonly left: SearchNode; readonly right: SearchNode }
  | { readonly type: 'or'; readonly left: SearchNode; readonly right: SearchNode };

/** Лексема выражения поиска. */
type Token =
  | { kind: 'word'; value: string }
  | { kind: 'phrase'; value: string }
  | { kind: 'and' }
  | { kind: 'or' }
  | { kind: 'not' }
  | { kind: 'open' }
  | { kind: 'close' };

/** Символы, которые не могут быть частью слова поиска. */
const WORD_BREAK = new Set(['(', ')', '"']);

function fail(reason: string): never {
  throw new ODataInvalidQueryError('$search', reason);
}

/**
 * Разбивает строку на лексемы.
 *
 * Кавычки и скобки прерывают слово без пробела: `NOT(ada)` и `"ada lovelace"` разбираются
 * так же, как записанные через пробел.
 */
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index] as string;

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (char === '(') {
      tokens.push({ kind: 'open' });
      index += 1;
      continue;
    }

    if (char === ')') {
      tokens.push({ kind: 'close' });
      index += 1;
      continue;
    }

    if (char === '"') {
      const { value, next } = readPhrase(source, index);

      tokens.push({ kind: 'phrase', value });
      index = next;
      continue;
    }

    let end = index;

    while (
      end < source.length &&
      !/\s/.test(source[end] as string) &&
      !WORD_BREAK.has(source[end] as string)
    ) {
      end += 1;
    }

    const word = source.slice(index, end);

    index = end;

    if (word === 'AND') {
      tokens.push({ kind: 'and' });
    } else if (word === 'OR') {
      tokens.push({ kind: 'or' });
    } else if (word === 'NOT') {
      tokens.push({ kind: 'not' });
    } else {
      tokens.push({ kind: 'word', value: word });
    }
  }

  return tokens;
}

/**
 * Читает фразу в двойных кавычках, начиная с открывающей.
 *
 * Внутри фразы `\"` даёт кавычку, а `\\` — обратную косую черту (OData 4.01, раздел 5.1.7).
 * В 4.0 экранирования не было вовсе, так что поддержка ничего не ломает: строки с обратной
 * косой чертой без кавычки после неё читаются как раньше.
 *
 * @throws {ODataInvalidQueryError} если кавычка не закрыта.
 */
function readPhrase(source: string, start: number): { value: string; next: number } {
  let value = '';
  let index = start + 1;

  while (index < source.length) {
    const char = source[index] as string;

    if (char === '\\' && (source[index + 1] === '"' || source[index + 1] === '\\')) {
      value += source[index + 1];
      index += 2;
      continue;
    }

    if (char === '"') {
      return { value, next: index + 1 };
    }

    value += char;
    index += 1;
  }

  return fail('unterminated phrase, expected a closing double quote');
}

/** Может ли лексема начинать очередной операнд — по этому определяется неявный `AND`. */
function startsTerm(token: Token | undefined): boolean {
  return (
    token !== undefined &&
    (token.kind === 'word' ||
      token.kind === 'phrase' ||
      token.kind === 'not' ||
      token.kind === 'open')
  );
}

/**
 * Разбирает выражение `$search`.
 *
 * @param source - значение параметра `$search`.
 * @returns дерево выражения либо `undefined`, если искать нечего (пустая строка).
 *
 * @throws {ODataInvalidQueryError} выражение синтаксически неверно: незакрытая кавычка
 *   или скобка, оператор без операнда, лишняя закрывающая скобка.
 *
 * @example
 * parseSearch('ada OR "grace hopper"');
 * // { type: 'or',
 * //   left:  { type: 'term', value: 'ada', phrase: false },
 * //   right: { type: 'term', value: 'grace hopper', phrase: true } }
 *
 * @example
 * parseSearch('ada NOT lovelace');   // ada AND NOT lovelace
 */
export function parseSearch(source: string): SearchNode | undefined {
  const tokens = tokenize(source);

  if (tokens.length === 0) {
    return undefined;
  }

  let position = 0;

  const peek = (): Token | undefined => tokens[position];
  const take = (): Token | undefined => tokens[position++];

  function parseExpression(): SearchNode {
    let node = parseAnd();

    while (peek()?.kind === 'or') {
      take();

      if (!startsTerm(peek())) {
        fail('OR must be followed by a search term');
      }

      node = { type: 'or', left: node, right: parseAnd() };
    }

    return node;
  }

  function parseAnd(): SearchNode {
    let node = parseNot();

    for (;;) {
      const next = peek();

      if (next?.kind === 'and') {
        take();

        if (!startsTerm(peek())) {
          fail('AND must be followed by a search term');
        }

        node = { type: 'and', left: node, right: parseNot() };
        continue;
      }

      // Пробел между операндами — тоже AND: `$search=ada lovelace` ищет оба слова.
      if (startsTerm(next)) {
        node = { type: 'and', left: node, right: parseNot() };
        continue;
      }

      return node;
    }
  }

  function parseNot(): SearchNode {
    if (peek()?.kind === 'not') {
      take();

      if (!startsTerm(peek())) {
        fail('NOT must be followed by a search term');
      }

      return { type: 'not', operand: parseNot() };
    }

    return parsePrimary();
  }

  function parsePrimary(): SearchNode {
    const token = take();

    if (!token) {
      return fail('unexpected end of expression');
    }

    if (token.kind === 'open') {
      if (!startsTerm(peek())) {
        fail('empty parentheses');
      }

      const inner = parseExpression();

      if (take()?.kind !== 'close') {
        fail('unbalanced parentheses, expected ")"');
      }

      return inner;
    }

    if (token.kind === 'word' || token.kind === 'phrase') {
      return { type: 'term', value: token.value, phrase: token.kind === 'phrase' };
    }

    return fail(`unexpected "${token.kind === 'close' ? ')' : token.kind.toUpperCase()}"`);
  }

  const result = parseExpression();

  if (position < tokens.length) {
    fail('unbalanced parentheses, unexpected ")"');
  }

  return result;
}
