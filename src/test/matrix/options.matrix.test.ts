/**
 * @file Матрица: опции выполнения (`alias`, `maxTop`, белые списки) и обработка ошибок.
 *
 * Проверяется на реальной БД, потому что все три возможности касаются стыка с TypeORM:
 * метаданных построителя, экранирования идентификаторов и итогового SQL.
 */
import {
  executeQuery,
  ODataInvalidQueryError,
  ODataParseError,
  ODataUnsupportedError,
  isODataClientError,
} from '../../lib';
import { Author, User } from '../fixtures';
import { dataSource } from '../setup/dataSource';
import { authorIds, rows, unwrap } from './helpers';

describe('alias', () => {
  /**
   * Раньше метаданные искались через `connection.getMetadata(alias)`, и произвольный алиас
   * приводил к `No metadata for "u" was found` (дефект A-03). Теперь они берутся
   * у самого построителя, и привычный TypeORM-стиль работает.
   */
  it('произвольный короткий алиас у QueryBuilder', async () => {
    const qb = dataSource.getRepository(Author).createQueryBuilder('u');
    const result = await executeQuery(qb, { $filter: "name eq 'Ada'" });

    expect(unwrap<Author>(result as Author[]).map((a) => a.id)).toEqual([1]);
  });

  it('произвольный алиас работает вместе с $expand и путями в фильтре', async () => {
    const qb = dataSource.getRepository(Author).createQueryBuilder('x');
    const result = await executeQuery(qb, {
      $expand: 'books',
      $filter: "books/title eq 'Analytical Engine'",
    });

    expect(unwrap<Author>(result as Author[]).map((a) => a.id)).toEqual([1]);
  });

  it('имя сущности по-прежнему принимается', async () => {
    expect(await authorIds({ $filter: "name eq 'Ada'" })).toEqual([1]);
  });

  /**
   * `options.alias` имеет приоритет над алиасом построителя — и именно поэтому для готового
   * `SelectQueryBuilder` его либо не задают вовсе, либо задают точно таким же.
   *
   * Алиас идёт в SQL как префикс колонок; если он разойдётся с корневым алиасом построителя,
   * СУБД не найдёт таблицу под этим именем. Тест закрепляет это как контракт, а не как дефект:
   * поведение осмысленно для ветки с `Repository`, где построитель создаётся тем же алиасом.
   */
  it('алиас, разошедшийся с алиасом построителя, даёт ошибку СУБД', async () => {
    const qb = dataSource.getRepository(Author).createQueryBuilder('ignored');

    // Текст ошибки у каждой СУБД свой («no such column» в SQLite, «missing FROM-clause
    // entry» в PostgreSQL), поэтому проверяем только сам факт отказа и упоминание алиаса.
    await expect(executeQuery(qb, { $select: 'id' }, { alias: 'chosen' })).rejects.toThrow(
      /chosen/
    );
  });

  it('совпадающий алиас в options допустим', async () => {
    const qb = dataSource.getRepository(Author).createQueryBuilder('u');
    const result = await executeQuery(qb, { $select: 'id' }, { alias: 'u' });

    expect(unwrap<Author>(result as Author[])).toHaveLength(4);
  });
});

describe('maxTop', () => {
  it('обрезает $top до разрешённого максимума', async () => {
    const result = await rows(
      dataSource.getRepository(Author),
      { $top: '100', $orderby: 'id asc' },
      'Author'
    );

    expect(result).toHaveLength(4);

    const limited = await executeQuery(
      dataSource.getRepository(Author),
      { $top: '100', $orderby: 'id asc' },
      { alias: 'Author', maxTop: 2 }
    );

    expect(unwrap<Author>(limited as Author[])).toHaveLength(2);
  });

  it('не трогает $top в пределах лимита', async () => {
    const result = await executeQuery(
      dataSource.getRepository(Author),
      { $top: '1', $orderby: 'id asc' },
      { alias: 'Author', maxTop: 10 }
    );

    expect(unwrap<Author>(result as Author[])).toHaveLength(1);
  });

  it('не ограничивает запрос без $top', async () => {
    const result = await executeQuery(
      dataSource.getRepository(Author),
      {},
      { alias: 'Author', maxTop: 2 }
    );

    // maxTop — потолок для явно запрошенной страницы, а не лимит по умолчанию
    expect(unwrap<Author>(result as Author[])).toHaveLength(4);
  });
});

describe('валидация пагинации', () => {
  it.each([
    ['$top', { $top: '-5' }],
    ['$skip', { $skip: '-1' }],
  ])('отрицательный %s отвергается', async (_name, query) => {
    await expect(
      executeQuery(dataSource.getRepository(Author), query, { alias: 'Author' })
    ).rejects.toThrow(ODataInvalidQueryError);
  });

  it('$top=0 остаётся корректным запросом пустой страницы', async () => {
    const result = await executeQuery(
      dataSource.getRepository(Author),
      { $top: '0', $count: 'true' },
      { alias: 'Author' }
    );

    expect(result).toEqual({ items: [], count: 4 });
  });
});

describe('белые списки полей и связей', () => {
  it('разрешённые поля проходят', async () => {
    const result = await rows(dataSource.getRepository(Author), { $select: 'id,name' }, 'Author');

    expect(result).toHaveLength(4);
  });

  it('$select с полем вне списка отвергается', async () => {
    await expect(
      executeQuery(
        dataSource.getRepository(Author),
        { $select: 'id,bio' },
        { alias: 'Author', allowedFields: ['id', 'name'] }
      )
    ).rejects.toThrow(ODataInvalidQueryError);
  });

  it('$filter с полем вне списка отвергается', async () => {
    await expect(
      executeQuery(
        dataSource.getRepository(Author),
        { $filter: 'age gt 30' },
        { alias: 'Author', allowedFields: ['id', 'name'] }
      )
    ).rejects.toThrow(ODataInvalidQueryError);
  });

  it('поле внутри функции тоже проверяется', async () => {
    // Разбор $filter регулярными выражениями такой случай бы пропустил —
    // поэтому список полей собирается посетителем во время обхода AST.
    await expect(
      executeQuery(
        dataSource.getRepository(Author),
        { $filter: "contains(bio,'x')" },
        { alias: 'Author', allowedFields: ['id', 'name'] }
      )
    ).rejects.toThrow(ODataInvalidQueryError);
  });

  it('$orderby с полем вне списка отвергается', async () => {
    await expect(
      executeQuery(
        dataSource.getRepository(Author),
        { $orderby: 'age desc' },
        { alias: 'Author', allowedFields: ['id', 'name'] }
      )
    ).rejects.toThrow(ODataInvalidQueryError);
  });

  it('$expand со связью вне списка отвергается', async () => {
    await expect(
      executeQuery(
        dataSource.getRepository(Author),
        { $expand: 'books' },
        { alias: 'Author', allowedExpands: [] }
      )
    ).rejects.toThrow(ODataInvalidQueryError);
  });

  it('связь, затронутая только фильтром, тоже проверяется', async () => {
    await expect(
      executeQuery(
        dataSource.getRepository(Author),
        { $filter: "books/title eq 'x'" },
        { alias: 'Author', allowedExpands: [] }
      )
    ).rejects.toThrow(ODataInvalidQueryError);
  });

  it('вложенная связь проверяется на своём уровне', async () => {
    await expect(
      executeQuery(
        dataSource.getRepository(Author),
        { $expand: 'books($expand=reviews)' },
        { alias: 'Author', allowedExpands: ['books'] }
      )
    ).rejects.toThrow(ODataInvalidQueryError);
  });

  it('разрешённая цепочка связей проходит', async () => {
    const result = await executeQuery(
      dataSource.getRepository(Author),
      { $expand: 'books($expand=reviews)', $filter: "name eq 'Ada'" },
      { alias: 'Author', allowedExpands: ['books', 'reviews'] }
    );

    expect(unwrap<Author>(result as Author[])[0]!.books).toHaveLength(2);
  });

  it('поле связи задаётся полным путём от корня', async () => {
    const result = await executeQuery(
      dataSource.getRepository(Author),
      { $select: 'id', $expand: 'books($select=title)', $filter: "name eq 'Ada'" },
      {
        alias: 'Author',
        // 'name' нужен фильтру, 'books/title' — вложенному $select.
        // Список покрывает все затронутые поля, а не только те, что в $select.
        allowedFields: ['id', 'name', 'books/title'],
        allowedExpands: ['books'],
      }
    );

    expect(unwrap<Author>(result as Author[])).toHaveLength(1);
  });

  it('вложенное поле связи вне списка отвергается', async () => {
    await expect(
      executeQuery(
        dataSource.getRepository(Author),
        { $expand: 'books($select=pages)' },
        { alias: 'Author', allowedFields: ['id', 'books/title'], allowedExpands: ['books'] }
      )
    ).rejects.toThrow(ODataInvalidQueryError);
  });

  it('без списков ограничений нет', async () => {
    const result = await rows(dataSource.getRepository(Author), { $expand: 'books' }, 'Author');

    expect(result).toHaveLength(4);
  });
});

describe('классификация ошибок', () => {
  it.each([
    ['синтаксис', { $filter: '!!!' }, ODataParseError],
    ['неподдерживаемая функция', { $filter: 'geo.distance(a,b) lt 1' }, ODataUnsupportedError],
    [
      'функция без трансляции',
      { $filter: 'fractionalseconds(registeredAt) eq 1' },
      ODataUnsupportedError,
    ],
    ['отрицательный $top', { $top: '-1' }, ODataInvalidQueryError],
  ])('%s → типизированная клиентская ошибка', async (_name, query, expected) => {
    let caught: unknown;

    try {
      await executeQuery(dataSource.getRepository(Author), query, { alias: 'Author' });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(expected);
    expect(isODataClientError(caught)).toBe(true);
  });

  it('ODataParseError указывает на сам сбойный символ', async () => {
    let caught: ODataParseError | undefined;

    try {
      await executeQuery(dataSource.getRepository(Author), { $filter: '!!!' }, { alias: 'Author' });
    } catch (e) {
      caught = e as ODataParseError;
    }

    expect(caught?.source).toContain('!!!');
    // Позиция — начало непонятного фрагмента, а не начало строки: прежний парсер
    // на любую ошибку отвечал `Fail at 0`, по которому нельзя было понять, где сбой.
    expect(caught?.position).toBe((caught?.source ?? '').indexOf('!!!'));
  });

  it('ошибка СУБД не считается ошибкой библиотеки', async () => {
    // Несуществующая колонка: по метаданным имена не проверяются, ошибка приходит от драйвера.
    let caught: unknown;

    try {
      await executeQuery(
        dataSource.getRepository(Author),
        { $filter: 'nonexistent eq 1' },
        { alias: 'Author' }
      );
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeDefined();
    expect(isODataClientError(caught)).toBe(false);
  });
});

/**
 * Дефект A-05: `$search` подставлял в SQL имя свойства класса вместо имени колонки и
 * цитировал идентификаторы жёстко зашитыми двойными кавычками. При snake_case-стратегии
 * запрос падал с `no such column: Author.isActive`.
 *
 * Отдельного подключения этому блоку больше не нужно: весь набор фикстур работает под
 * `SnakeCaseNamingStrategy`, то есть имена колонок в базе не совпадают с именами свойств
 * во **всех** тестах, а не в одном специальном. Здесь проверка остаётся прицельной —
 * чтобы при падении сразу было видно, что сломался именно этот разрыв.
 */
describe('$search и имена колонок, отличные от имён свойств', () => {
  it('ищет по текстовой колонке', async () => {
    const result = await rows(dataSource.getRepository(Author), { $search: 'codebreak' }, 'Author');

    expect(result.map((author) => author.name)).toEqual(['Alan']);
  });

  it('ищет по числовой колонке', async () => {
    const result = await rows(dataSource.getRepository(Author), { $search: '45' }, 'Author');

    expect(result.map((author) => author.name)).toEqual(['Grace']);
  });

  it('$filter по колонке со snake_case-именем работает', async () => {
    // `isActive` в базе называется `is_active`: путь свойства обязан транслироваться.
    expect(await authorIds({ $filter: 'isActive eq false' })).toEqual([3]);
  });

  it('$orderby по колонке со snake_case-именем работает', async () => {
    expect(
      await authorIds({ $orderby: 'registeredAt asc', $filter: 'registeredAt ne null' })
    ).toEqual([1, 2, 4]);
  });
});

/**
 * Дефект A-12: колонки с `@Column({ select: false })` возвращались клиенту.
 *
 * Такая пометка — способ TypeORM сказать «эта колонка не покидает сервер по умолчанию»;
 * типовое применение — хеши паролей и токены. Собственный `find()` в TypeORM их скрывает,
 * а библиотека возвращала их **на каждом запросе**, даже без единого параметра, потому что
 * строила список SELECT из всех невиртуальных колонок и явно переопределяла умолчание TypeORM.
 *
 * Скрытая колонка живёт в общих фикстурах ({@link User.passwordHash}), поэтому проверка
 * идёт на той же схеме, что и остальные тесты, и на том же наборе данных, что видит демо.
 */
describe('колонки с select: false', () => {
  const query = (params: Record<string, string>) =>
    executeQuery(dataSource.getRepository(User), params, { alias: 'User' });

  it('скрытая колонка не попадает в ответ по умолчанию', async () => {
    const result = unwrap<User>((await query({ $orderby: 'id asc' })) as User[]);

    expect(result[0]).toEqual({ id: 1, name: 'Alice', email: 'alice@example.com' });
    expect(JSON.stringify(result)).not.toContain('scrypt');
  });

  it('поведение совпадает с find() самого TypeORM', async () => {
    const viaLibrary = unwrap<User>((await query({ $orderby: 'id asc' })) as User[]);
    const viaTypeorm = await dataSource.getRepository(User).find({ order: { id: 'ASC' } });

    expect(viaLibrary).toEqual(viaTypeorm);
  });

  it.each([
    ['$select', { $select: 'id,passwordHash' }],
    ['$filter', { $filter: "passwordHash eq 'scrypt$alice$00000000'" }],
    ['$orderby', { $orderby: 'passwordHash asc' }],
  ])('обращение к скрытой колонке через %s отвергается', async (_name, params) => {
    // $filter и $orderby не возвращают значение колонки, но работают как оракул:
    // по числу строк в ответе значение подбирается.
    await expect(query(params)).rejects.toThrow(ODataInvalidQueryError);
  });

  it('обычные колонки по-прежнему доступны', async () => {
    const result = unwrap<User>(
      (await query({ $select: 'id,name', $orderby: 'id asc' })) as User[]
    );

    expect(result[0]).toEqual({ id: 1, name: 'Alice' });
  });
});
