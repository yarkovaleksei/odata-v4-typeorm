/**
 * @file Разбор строки системных query options.
 *
 * Отдельно от `parseFilter`: там грамматика выражений, здесь — то, как выражения и списки
 * разложены по опциям, и как разделители не путаются с содержимым литералов.
 */
import { ODataParseError } from '../errors';
import { parseQueryOptions } from './parseQueryOptions';
import { TokenType, type Token } from './token';

/** Опция по типу — в дереве они лежат списком. */
function option(source: string, type: TokenType): Token {
  const found = parseQueryOptions(source).value.options.find((o: Token) => o.type === type);

  if (!found) {
    throw new Error(`в разобранном запросе нет опции ${type}`);
  }

  return found;
}

describe('parseQueryOptions', () => {
  it('пустая строка даёт запрос без опций', () => {
    expect(parseQueryOptions('').value.options).toEqual([]);
  });

  it('несколько опций через &', () => {
    const options = parseQueryOptions('$top=5&$skip=2&$count=true').value.options;

    expect(options.map((o: Token) => o.type)).toEqual([
      TokenType.Top,
      TokenType.Skip,
      TokenType.InlineCount,
    ]);
  });

  describe('$filter', () => {
    it('значение разбирается как выражение', () => {
      expect(option("$filter=name eq 'Ada'", TokenType.Filter).value.type).toBe(
        TokenType.EqualsExpression
      );
    });

    /**
     * `encodeURI` не кодирует амперсанд, поэтому он совершенно законно встречается внутри
     * литерала. Разбиение строки по `&` разорвало бы такой запрос пополам — здесь опции
     * читает тот же курсор, что и выражения.
     */
    it('амперсанд внутри литерала не разделяет опции', () => {
      const options = parseQueryOptions("$filter=name eq 'A&B'&$top=5").value.options;

      expect(options).toHaveLength(2);
      expect(options[0].value.value.right.raw).toBe("'A&B'");
    });
  });

  describe('$select', () => {
    it('список полей', () => {
      const items = option('$select=id,name', TokenType.Select).value.items;

      expect(items.map((i: Token) => i.raw)).toEqual(['id', 'name']);
    });

    it('путь через связь остаётся в raw целиком', () => {
      const items = option('$select=id,author/name', TokenType.Select).value.items;

      expect(items[1].raw).toBe('author/name');
    });
  });

  describe('$orderby', () => {
    it('направление по умолчанию — по возрастанию', () => {
      const items = option('$orderby=name', TokenType.OrderBy).value.items;

      expect(items[0].value.direction).toBe(1);
    });

    it('desc даёт обратное направление', () => {
      const items = option('$orderby=name desc,id asc', TokenType.OrderBy).value.items;

      expect(items.map((i: Token) => i.value.direction)).toEqual([-1, 1]);
    });

    it('сортировка по пути через связь', () => {
      const items = option('$orderby=author/name desc', TokenType.OrderBy).value.items;

      expect(items[0].value.expr.raw).toBe('author/name');
    });
  });

  describe('$expand', () => {
    it('несколько связей', () => {
      const items = option('$expand=books,tags', TokenType.Expand).value.items;

      expect(items.map((i: Token) => i.value.path.raw)).toEqual(['books', 'tags']);
    });

    it('вложенные опции в скобках', () => {
      const items = option('$expand=books($select=title;$top=2;$orderby=id desc)', TokenType.Expand)
        .value.items;

      expect(items[0].value.options.map((o: Token) => o.type)).toEqual([
        TokenType.Select,
        TokenType.Top,
        TokenType.OrderBy,
      ]);
    });

    it('запятая внутри вложенного $select не разрывает список связей', () => {
      const items = option('$expand=books($select=id,title),tags', TokenType.Expand).value.items;

      expect(items).toHaveLength(2);
      expect(items[0].value.options[0].value.items).toHaveLength(2);
      expect(items[1].value.path.raw).toBe('tags');
    });

    it('вложенный $expand второго уровня', () => {
      const items = option('$expand=books($expand=reviews)', TokenType.Expand).value.items;
      const nested = items[0].value.options[0].value.items;

      expect(nested[0].value.path.raw).toBe('reviews');
    });

    it('вложенный $filter', () => {
      const items = option('$expand=books($filter=pages gt 100)', TokenType.Expand).value.items;

      expect(items[0].value.options[0].value.type).toBe(TokenType.GreaterThanExpression);
    });
  });

  describe('$compute', () => {
    it('выражение и имя', () => {
      const items = option('$compute=pages mul 2 as doubled', TokenType.Compute).value.items;

      expect(items).toHaveLength(1);
      expect(items[0].value.name).toBe('doubled');
      expect(items[0].value.expr.type).toBe(TokenType.MulExpression);
    });

    it('несколько выражений через запятую', () => {
      const items = option(
        '$compute=pages mul 2 as doubled, concat(title,title) as twice',
        TokenType.Compute
      ).value.items;

      expect(items.map((item: Token) => item.value.name)).toEqual(['doubled', 'twice']);
    });

    it('внутри $expand', () => {
      const items = option('$expand=books($compute=pages add 1 as p)', TokenType.Expand).value
        .items;

      expect(items[0].value.options[0].type).toBe(TokenType.Compute);
    });

    it.each([
      ['без "as"', '$compute=pages mul 2'],
      ['без имени', '$compute=pages mul 2 as'],
      ['имя не идентификатор', "$compute=pages mul 2 as 'x'"],
    ])('%s — ошибка разбора', (_name, source) => {
      expect(() => parseQueryOptions(source)).toThrow(ODataParseError);
    });
  });

  describe('числа и логические значения', () => {
    it('$top и $skip', () => {
      expect(option('$top=25', TokenType.Top).value.raw).toBe('25');
      expect(option('$skip=10', TokenType.Skip).value.raw).toBe('10');
    });

    it('отрицательное значение разбирается — проверяет его вызывающий код', () => {
      // Отрицательный $top — ошибка клиента, а не синтаксиса, и сообщение о ней
      // должно называть параметр, а не позицию символа.
      expect(option('$top=-5', TokenType.Top).value.raw).toBe('-5');
    });

    it('$count', () => {
      expect(option('$count=true', TokenType.InlineCount).value.raw).toBe('true');
      expect(option('$count=false', TokenType.InlineCount).value.raw).toBe('false');
    });
  });

  /**
   * `$search` — единственная известная опция, значение которой этот парсер не разбирает:
   * у неё своя грамматика, и занимается ей `parseSearch`, а в обычном конвейере опция
   * отделяется ещё раньше — `executeQueryByQueryBuilder` вынимает её до склейки строки.
   * Читается она здесь ровно затем, чтобы строка, где `$search` записан вместе
   * с остальными опциями, не отвергалась целиком.
   */
  describe('$search', () => {
    it('значение читается как есть, до разделителя опций', () => {
      expect(option('$search=ada lovelace', TokenType.Search).value.raw).toBe('ada lovelace');
    });

    it('не мешает соседним опциям', () => {
      const options = parseQueryOptions('$search=ada&$top=5').value.options;

      expect(options.map((o: Token) => o.type)).toEqual([TokenType.Search, TokenType.Top]);
      expect(option('$search=ada&$top=5', TokenType.Top).value.raw).toBe('5');
    });

    it('операторы и кавычки грамматики поиска доезжают до значения нетронутыми', () => {
      expect(option('$search=(ada OR grace) NOT hopper', TokenType.Search).value.raw).toBe(
        '(ada OR grace) NOT hopper'
      );
    });

    /**
     * Амперсанд внутри кавычек не считается разделителем — ровно как и в `$filter`:
     * иначе фраза `"black & white"` разорвала бы строку опций пополам.
     */
    it('амперсанд внутри строкового литерала не обрывает значение', () => {
      expect(option("$search='black & white'&$top=1", TokenType.Search).value.raw).toBe(
        "'black & white'"
      );
    });
  });

  describe('ошибки', () => {
    it.each([
      ['неизвестная опция', '$apply=groupby((a))'],
      ['опция без $', 'top=5'],
      ['опция без значения', '$top='],
      ['нечисловой $top', '$top=abc'],
      ['нелогический $count', '$count=1'],
      ['незакрытая скобка вложенных опций', '$expand=books($top=2'],
      ['мусор после опций', '$top=5 abc'],
    ])('%s', (_name, source) => {
      expect(() => parseQueryOptions(source)).toThrow(ODataParseError);
    });

    it('сообщение называет неподдерживаемую опцию', () => {
      expect(() => parseQueryOptions('$apply=groupby((a))')).toThrow(/\$apply/);
    });
  });
});
