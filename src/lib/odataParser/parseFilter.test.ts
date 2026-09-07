/**
 * @file Разбор выражений `$filter`.
 *
 * Проверяется структура дерева и распознавание литералов — то, из чего посетитель потом
 * собирает SQL. Сам SQL проверяют тесты `TypeOrmVisitor` и матрица на живой базе; дублировать
 * их здесь значило бы проверять одно и то же дважды.
 */
import { ODataParseError } from '../errors';
import { parseFilter } from './parseFilter';
import { TokenType, type Token } from './token';

/** Тип узла и его исходный текст — короткая запись для сравнения. */
function shape(node: Token): string {
  return `${node.type}(${node.raw})`;
}

/** Тип литерала EDM, распознанный для выражения `x eq <литерал>`. */
function literalType(literal: string): unknown {
  return parseFilter(`x eq ${literal}`).value.right.value;
}

describe('parseFilter', () => {
  describe('операторы сравнения', () => {
    it.each([
      ['eq', TokenType.EqualsExpression],
      ['ne', TokenType.NotEqualsExpression],
      ['gt', TokenType.GreaterThanExpression],
      ['ge', TokenType.GreaterOrEqualsExpression],
      ['lt', TokenType.LesserThanExpression],
      ['le', TokenType.LesserOrEqualsExpression],
    ])('%s', (operator, type) => {
      expect(parseFilter(`age ${operator} 18`).type).toBe(type);
    });

    it('операнды разложены на левый и правый', () => {
      const node = parseFilter("name eq 'Ada'");

      expect(shape(node.value.left)).toBe('PropertyPathExpression(name)');
      expect(shape(node.value.right)).toBe("Literal('Ada')");
    });
  });

  describe('приоритет операторов', () => {
    it('and связывает сильнее or', () => {
      // a or (b and c)
      const node = parseFilter('a eq 1 or b eq 2 and c eq 3');

      expect(node.type).toBe(TokenType.OrExpression);
      expect(node.value.right.type).toBe(TokenType.AndExpression);
    });

    /**
     * Прежний парсер читал это как `not (X and Y)`: отрицание захватывало всё выражение.
     * Расхождение было записано в документации как известное — и чинится своим парсером.
     */
    it('not не захватывает следующий and', () => {
      const node = parseFilter('not (a eq 1) and b eq 2');

      expect(node.type).toBe(TokenType.AndExpression);
      expect(node.value.left.type).toBe(TokenType.NotExpression);
    });

    it('not относится к ближайшему сравнению', () => {
      const node = parseFilter('not a eq 1');

      expect(node.type).toBe(TokenType.NotExpression);
      expect(node.value.type).toBe(TokenType.EqualsExpression);
    });

    it('умножение связывает сильнее сложения', () => {
      // a + (b * c)
      const node = parseFilter('a add b mul c eq 1');

      expect(node.value.left.type).toBe(TokenType.AddExpression);
      expect(node.value.left.value.right.type).toBe(TokenType.MulExpression);
    });

    it('скобки меняют приоритет', () => {
      const node = parseFilter('(a add b) mul c eq 1');

      expect(node.value.left.type).toBe(TokenType.MulExpression);
      expect(node.value.left.value.left.type).toBe(TokenType.ParenExpression);
    });

    it('скобки вокруг логического выражения дают отдельный тип узла', () => {
      const node = parseFilter('(a eq 1 or b eq 2) and c eq 3');

      expect(node.value.left.type).toBe(TokenType.BoolParenExpression);
    });

    it('сравнение не цепочечное', () => {
      expect(() => parseFilter('a lt b lt c')).toThrow(ODataParseError);
    });
  });

  describe('литералы', () => {
    it.each([
      ["'Ada'", 'Edm.String'],
      ["'it''s'", 'Edm.String'],
      ['42', 'Edm.Int64'],
      ['-7', 'Edm.Int64'],
      ['3.14', 'Edm.Decimal'],
      ['1e3', 'Edm.Decimal'],
      ['true', 'Edm.Boolean'],
      ['false', 'Edm.Boolean'],
      ['null', 'null'],
      ['INF', 'Edm.Double'],
      ['NaN', 'Edm.Double'],
      ['2020-01-15', 'Edm.Date'],
      ['2020-01-15T10:30:00Z', 'Edm.DateTimeOffset'],
      ['2020-01-15T10:30:00+03:00', 'Edm.DateTimeOffset'],
      ['08:00:00', 'Edm.TimeOfDay'],
      ['08:00', 'Edm.TimeOfDay'],
      ['0f8fad5b-d9cb-469f-a165-70867728950e', 'Edm.Guid'],
      ["duration'P1D'", 'Edm.Duration'],
    ])('%s → %s', (literal, edmType) => {
      expect(literalType(literal)).toBe(edmType);
    });

    it('минус перед числом — часть литерала, а не оператор', () => {
      expect(parseFilter('age gt -7').value.right.type).toBe(TokenType.Literal);
    });

    it('минус перед полем — оператор отрицания', () => {
      expect(parseFilter('-age gt 7').value.left.type).toBe(TokenType.NegateExpression);
    });

    it('дата не путается с GUID, а время — с числом', () => {
      // Обе пары начинаются одинаково, и порядок проверки шаблонов здесь решает всё.
      expect(literalType('2020-01-15')).toBe('Edm.Date');
      expect(literalType('08:00:00')).toBe('Edm.TimeOfDay');
      expect(literalType('2020')).toBe('Edm.Int64');
    });

    it('строка с апострофом внутри читается целиком', () => {
      expect(parseFilter("name eq 'it''s'").value.right.raw).toBe("'it''s'");
    });

    it('амперсанд внутри строки не считается концом выражения', () => {
      expect(parseFilter("name eq 'A&B'").value.right.raw).toBe("'A&B'");
    });
  });

  describe('пути свойств', () => {
    it('простое имя', () => {
      const node = parseFilter('name eq 1').value.left;

      expect(node.type).toBe(TokenType.PropertyPathExpression);
      expect(node.value.type).toBe(TokenType.ODataIdentifier);
      expect(node.value.value.name).toBe('name');
    });

    it('путь через связь', () => {
      const node = parseFilter('author/name eq 1').value.left;

      expect(node.raw).toBe('author/name');
      expect(node.value.current.value.name).toBe('author');
      expect(node.value.next.raw).toBe('name');
    });

    it('путь через две связи', () => {
      const node = parseFilter('books/reviews/score gt 1').value.left;

      expect(node.raw).toBe('books/reviews/score');
      expect(node.value.next.value.next.raw).toBe('score');
    });

    it('имя, начинающееся с ключевого слова, не разбирается как оператор', () => {
      // `andrew` не должно стать оператором `and` с мусором после него.
      expect(parseFilter('andrew eq 1').value.left.raw).toBe('andrew');
      expect(parseFilter('notes eq 1').value.left.raw).toBe('notes');
    });
  });

  describe('лямбда-операторы', () => {
    it('any с условием', () => {
      const node = parseFilter("books/any(b: b/title eq 'x')");

      expect(node.type).toBe(TokenType.LambdaExpression);
      expect(node.value.operator).toBe('any');
      expect(node.value.navigation).toEqual(['books']);
      expect(node.value.variable).toBe('b');
      expect(node.value.predicate.type).toBe(TokenType.EqualsExpression);
    });

    it('all', () => {
      expect(parseFilter('books/all(b: b/pages gt 100)').value.operator).toBe('all');
    });

    it('any без условия означает «коллекция непуста»', () => {
      const node = parseFilter('books/any()');

      expect(node.value.predicate).toBeUndefined();
      expect(node.value.variable).toBe('');
    });

    it('путь до коллекции может быть составным', () => {
      expect(parseFilter('books/reviews/any(r: r/score gt 4)').value.navigation).toEqual([
        'books',
        'reviews',
      ]);
    });

    it('вложенная лямбда', () => {
      const node = parseFilter('books/any(b: b/reviews/any(r: r/score gt 4))');

      expect(node.value.predicate.type).toBe(TokenType.LambdaExpression);
      expect(node.value.predicate.value.variable).toBe('r');
    });

    it('лямбда сочетается с другими условиями', () => {
      const node = parseFilter("name eq 'Ada' and books/any(b: b/pages gt 100)");

      expect(node.type).toBe(TokenType.AndExpression);
      expect(node.value.right.type).toBe(TokenType.LambdaExpression);
    });
  });

  describe('оператор in', () => {
    it('список значений', () => {
      const node = parseFilter('age in (30, 40, 50)');

      expect(node.type).toBe(TokenType.InExpression);
      expect(node.value.left.raw).toBe('age');
      expect(node.value.values).toHaveLength(3);
    });

    it('список строк', () => {
      expect(parseFilter("name in ('Ada', 'Grace')").value.values[1].raw).toBe("'Grace'");
    });

    it('пустой список разбирается', () => {
      expect(parseFilter('age in ()').value.values).toHaveLength(0);
    });

    it('сочетается с другими условиями', () => {
      expect(parseFilter('age in (30, 40) and isActive eq true').type).toBe(
        TokenType.AndExpression
      );
    });

    it('без скобок — синтаксическая ошибка', () => {
      expect(() => parseFilter('age in 30')).toThrow(ODataParseError);
    });
  });

  describe('вызовы функций', () => {
    it('с двумя аргументами', () => {
      const node = parseFilter("contains(name, 'da')");

      expect(node.type).toBe(TokenType.MethodCallExpression);
      expect(node.value.method).toBe('contains');
      expect(node.value.parameters).toHaveLength(2);
    });

    it('без аргументов', () => {
      expect(parseFilter('createdAt lt now()').value.right.value.parameters).toHaveLength(0);
    });

    it('аргументом может быть выражение', () => {
      const node = parseFilter('round(price mul 2) eq 10');

      expect(node.value.left.value.parameters[0].type).toBe(TokenType.MulExpression);
    });

    /**
     * Составное имя разбирается, хотя такой функции у библиотеки нет: отказ должен прийти
     * от посетителя и назвать функцию, а не сообщить о непонятном символе.
     */
    it('составное имя функции разбирается', () => {
      expect(parseFilter('geo.distance(a,b) lt 1').value.left.value.method).toBe('geo.distance');
    });

    /**
     * Составное имя без скобки в грамматике OData может быть только именем типа: сегменты
     * пути свойства разделяет `/`, а не `.`. Раньше такая запись отвергалась парсером,
     * и `cast` не доходил до посетителя вовсе — отказ приходил с позицией символа
     * вместо названия конструкции (R-43).
     */
    it('точка вне вызова функции даёт имя типа', () => {
      const node = parseFilter('cast(age,Edm.String) eq 1');
      const [value, type] = node.value.left.value.parameters;

      expect(node.value.left.value.method).toBe('cast');
      expect(value.raw).toBe('age');
      expect(type.type).toBe(TokenType.TypeReference);
      expect(type.value.name).toBe('Edm.String');
    });

    it('имя типа разбирается и вне cast — отвергает его посетитель', () => {
      expect(parseFilter('name eq Edm.String').value.right.type).toBe(TokenType.TypeReference);
    });
  });

  describe('процентное кодирование', () => {
    it('%20 разделяет слова', () => {
      expect(parseFilter("name%20eq%20'Ada'").type).toBe(TokenType.EqualsExpression);
    });

    it('содержимое литерала остаётся закодированным — его раскодирует convertLiteral', () => {
      expect(parseFilter("name eq 'a%20b'").value.right.raw).toBe("'a%20b'");
    });
  });

  describe('ошибки', () => {
    it.each([
      ['мусор', '!!!'],
      ['оператор без правого операнда', 'name eq'],
      ['незакрытая строка', "name eq 'Ada"],
      ['незакрытая скобка', '(name eq 1'],
      ['лишняя закрывающая скобка', 'name eq 1)'],
      ['пустое выражение', ''],
      ['вызов без закрывающей скобки', "contains(name, 'a'"],
    ])('%s', (_name, expression) => {
      expect(() => parseFilter(expression)).toThrow(ODataParseError);
    });

    it('позиция указывает на сбойный символ, а не на начало строки', () => {
      let caught: ODataParseError | undefined;

      try {
        parseFilter('name eq !!!');
      } catch (e) {
        caught = e as ODataParseError;
      }

      expect(caught?.position).toBe(8);
    });

    it('лямбда без двоеточия — синтаксическая ошибка', () => {
      expect(() => parseFilter("posts/any(p p/title eq 'x')")).toThrow(ODataParseError);
    });

    it('all без условия отвергается: он был бы истинным для чего угодно', () => {
      expect(() => parseFilter('posts/all()')).toThrow(ODataParseError);
    });
  });
});
