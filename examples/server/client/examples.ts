/**
 * @file Сборка примеров запросов под выбранную сущность.
 *
 * Главный модуль страницы и единственный, который стоит читать, чтобы понять, откуда
 * берутся примеры. Раньше они были записаны константой и после правки сущности молча
 * начинали ссылаться на поля, которых уже нет.
 *
 * ФУНКЦИЯ ЧИСТАЯ. Ни DOM, ни сети: на вход — схема и строки, на выход — список примеров.
 * Так её можно прогнать в Node и проверить каждый пример против живого сервера,
 * не поднимая браузер.
 *
 * ДВА ПРАВИЛА, которым подчиняется каждый пример:
 *
 * 1. он добавляется, только если в схеме есть подходящее поле или связь — у сущности
 *    из двух колонок примеров будет меньше, и ни один не сошлётся на несуществующее;
 * 2. он возвращает непустую выборку — значения берутся из реальных строк. Пример,
 *    отдающий пустой массив, не показывает, работает фильтр или нет.
 */
import { kindOf } from './edm.js';
import { findRelationTarget } from './schema.js';
import { fragmentOf, hasNull, maxValueOf, quote, relationValueOf, valueOf } from './samples.js';
import type { Example, QueryDraft, Row, SchemaResource } from './types.js';

/**
 * Собирает примеры под сущность.
 *
 * @param resource - описание выбранной сущности.
 * @param schema - вся схема: нужна, чтобы узнать поля сущностей на другом конце связей.
 * @param rows - образцы строк; пустой массив допустим — тогда останутся примеры,
 *   которым значения не нужны.
 * @param total - сколько всего строк у сущности. Отличается от `rows.length`, когда ответ
 *   обрезан потолком `maxTop` либо размером выборки; на этом различии держится пример
 *   с усечением.
 */
export function generateExamples(
  resource: SchemaResource,
  schema: SchemaResource[],
  rows: Row[],
  total = rows.length
): Example[] {
  const examples: Example[] = [];
  const add = (title: string, query: QueryDraft, expectError?: boolean): void => {
    examples.push(expectError ? { title, query, expectError } : { title, query });
  };

  const names = resource.fields.map((field) => field.name);
  const byKind = (kind: string) => resource.fields.filter((field) => kindOf(field) === kind);

  const first = names[0] ?? 'id';
  const orderField = names.find((name) => name !== first) ?? first;

  // ── Базовые: нужны только имена полей ──────────────────────────────────────
  add('Все записи', {});

  if (names.length > 1) {
    add('Выбор полей', { $select: names.slice(0, 2).join(',') });
  }

  add('Сортировка', { $orderby: `${orderField} desc` });
  add('Пагинация со счётчиком', {
    $orderby: `${first} asc`,
    $top: '2',
    $skip: '1',
    $count: 'true',
  });
  add('Пустая страница, только счётчик', { $top: '0', $count: 'true' });

  // Усечение до maxTop добавляется, только когда его видно: при потолке больше числа строк
  // ответ на завышенный `$top` ничем не отличается от ответа без потолка, и пример
  // показывал бы ровно ничего. Со `$count=true` разница видна в одном ответе:
  // items обрезан до потолка, count по-прежнему полный — режется страница, а не выборка.
  if (total > resource.maxTop) {
    add(`Усечение до maxTop (${resource.maxTop})`, {
      $top: String(resource.maxTop * 10),
      $count: 'true',
    });
  }

  // ── Фильтры по типам полей ────────────────────────────────────────────────
  const [stringField] = byKind('string');
  const [guidField] = byKind('guid');
  const [booleanField] = byKind('boolean');
  const [dateField] = byKind('datetime');

  // Первичный ключ берётся только за неимением другого числового поля: `id ge 1` вернёт
  // все строки и ничего не покажет, а `age ge 45` — покажет работу фильтра.
  const numbers = byKind('number');
  const numberField = numbers.find((field) => field.name !== 'id') ?? numbers[0];

  if (stringField) {
    const value = valueOf(rows, stringField.name);

    if (value !== undefined) {
      const name = stringField.name;

      add('Поиск по подстроке', { $filter: `contains(${name},${quote(fragmentOf(value))})` });
      add('Равенство строк', { $filter: `${name} eq ${quote(value)}` });
      add('Строковые функции', {
        $filter: `length(${name}) gt 2 and startswith(${name},${quote(String(value).slice(0, 1))})`,
      });

      // Ожидаемая строка считается тем же способом, что и в SQL — заменой ВСЕХ вхождений,
      // — поэтому пример всегда возвращает ту строку, из которой взят фрагмент.
      //
      // Фрагмент берётся коротким, а не первым словом: заменив слово целиком, пример
      // показал бы `replace(name,'Ada','ADA') eq 'ADA'`, где замену от обычного равенства
      // не отличить.
      const fragment = String(value).slice(0, 2);

      if (fragment) {
        const upper = fragment.toUpperCase();

        add('Замена подстроки', {
          $filter:
            `replace(${name},${quote(fragment)},${quote(upper)}) eq ` +
            `${quote(String(value).replaceAll(fragment, upper))}`,
        });
      }

      add('Поиск по всем полям ($search)', { $search: fragmentOf(value) });
    }
  }

  // Примеры с перечислением строятся по двум РАЗНЫМ значениям одного поля: со списком
  // из одного элемента `in` неотличим от `eq`, а `OR` в `$search` — от обычного слова.
  if (stringField) {
    const distinct = [
      ...new Set(
        rows
          .map((row) => row[stringField.name])
          .filter((value): value is string => typeof value === 'string')
      ),
    ].slice(0, 2);

    if (distinct.length === 2) {
      add('Оператор in', {
        $filter: `${stringField.name} in (${distinct.map((value) => quote(value)).join(',')})`,
      });
      add('Поиск по выражению ($search с OR)', {
        $search: distinct.map((value) => `"${value}"`).join(' OR '),
      });
    }
  }

  if (guidField) {
    const value = valueOf(rows, guidField.name);

    if (value !== undefined) {
      // Единственное осмысленное выражение для GUID — сравнение целиком: подстроки
      // и длина к нему неприменимы, см. `edm.ts`.
      add('Равенство по ключу UUID', { $filter: `${guidField.name} eq ${quote(value)}` });
    }
  }

  if (numberField) {
    const threshold = maxValueOf(rows, numberField.name);

    if (threshold !== undefined) {
      const name = numberField.name;

      add('Сравнение чисел', { $filter: `${name} ge ${threshold}`, $orderby: `${name} asc` });
      add('Арифметика', { $filter: `${name} mul 2 ge ${threshold * 2}` });

      // Сравнение числового поля с длительностью выглядит искусственно, но показать
      // `totalseconds` иначе не на чем: колонки типа `Edm.Duration` в схеме нет и быть
      // не может — типа интервала нет ни в SQLite, ни в MySQL. Работает здесь именно
      // литерал: он сворачивается в число ещё при компиляции, до всякого SQL.
      add('Длительность в секундах', {
        $filter: `${name} le totalseconds(duration'PT${threshold}S')`,
      });

      // Приведение к строке — то, ради чего `cast` и применяется: искать подстроку
      // в числе иначе нечем. Сравнивается не всё значение, а первый его знак: текстовая
      // форма дробного числа зависит от масштаба колонки (`12.5` против `12.50`),
      // и пример на равенстве оказался бы верным не на всякой сущности.
      const digit = String(threshold).slice(0, 1);

      add('Приведение числа к строке', {
        $filter: `contains(cast(${name},Edm.String),${quote(digit)})`,
      });
    }
  }

  if (booleanField) {
    const value = valueOf(rows, booleanField.name);

    if (value !== undefined) {
      add('Булево поле', { $filter: `${booleanField.name} eq ${Boolean(value)}` });
    }
  }

  if (dateField) {
    const value = valueOf(rows, dateField.name);
    const year = value === undefined ? Number.NaN : new Date(String(value)).getFullYear();

    if (Number.isFinite(year)) {
      add('Функции даты', { $filter: `year(${dateField.name}) eq ${year}` });

      // Условие `lt 1` выполняется для любой непустой даты: дробная часть секунд по
      // определению лежит в [0, 1). У колонки, объявленной без дробной части, значение
      // всегда нулевое — сравнение с нулём показывало бы не работу функции, а точность
      // хранилища.
      add('Дробная часть секунд', { $filter: `fractionalseconds(${dateField.name}) lt 1` });

      // Обе границы разом: диапазон покрывает любое хранимое значение, поэтому пример
      // возвращает все строки с непустой датой. Границей служит диапазон хранения самой
      // СУБД — в MySQL он начинается с 1000 года, и подставляется именно он.
      add('Границы диапазона дат', {
        $filter: `${dateField.name} ge mindatetime() and ${dateField.name} le maxdatetime()`,
      });
    }
  }

  const nullableField = resource.fields.find(
    (field) => field.nullable && hasNull(rows, field.name)
  );

  if (nullableField) {
    add('Сравнение с null', { $filter: `${nullableField.name} eq null` });
    // Второе условие намеренно `ne null`, а не сравнение с числом: ключ бывает и UUID,
    // и тогда `id ge 1` — сравнение строки с числом, то есть ошибка уровня СУБД.
    // Здесь важен приоритет `not`, а не смысл второго условия: отрицание относится
    // только к первому, скобки вокруг него не нужны.
    add('Отрицание с приоритетом', {
      $filter: `not (${nullableField.name} eq null) and ${first} ne null`,
    });
  }

  // ── Связи ─────────────────────────────────────────────────────────────────
  const single = resource.relations.find((relation) => !relation.collection);
  const collection = resource.relations.find((relation) => relation.collection);

  if (single) {
    add('Связь «к одному»', { $expand: single.name });

    const target = findRelationTarget(schema, single);
    const targetField = target?.fields.find((field) => kindOf(field) === 'string');

    if (targetField) {
      const value = relationValueOf(rows, single.name, targetField.name);

      if (value !== undefined) {
        add('Фильтр по полю связи', {
          $filter: `${single.name}/${targetField.name} eq ${quote(value)}`,
          $expand: single.name,
        });
      }

      add('Вложенный $select внутри $expand', {
        $expand: `${single.name}($select=${targetField.name})`,
        $select: names.slice(0, 2).join(','),
      });
      add('Сортировка по полю связи', {
        $orderby: `${single.name}/${targetField.name} asc`,
        $expand: single.name,
      });
    }
  }

  if (collection) {
    add('Связь «ко многим»', { $expand: collection.name });
    add('Вложенная пагинация внутри $expand', {
      $expand: `${collection.name}($orderby=id desc;$top=1)`,
    });

    const target = findRelationTarget(schema, collection);
    const candidates = target?.relations.filter((relation) => !relation.collection) ?? [];

    // Предпочитается связь, ведущая к третьей сущности: `books($expand=author)` показывает
    // три уровня, а `posts($expand=user)` возвращает к той, с которой начали, и выглядит
    // как ошибка, хотя и работает.
    const nested =
      candidates.find((relation) => relation.target !== resource.alias) ?? candidates[0];

    if (nested) {
      add('Три уровня $expand', { $expand: `${collection.name}($expand=${nested.name})` });
    }

    // Лямбды не размножают корневые строки: они разворачиваются в EXISTS, а не в JOIN.
    add('Лямбда any — коллекция непуста', { $filter: `${collection.name}/any()` });

    const targetField = target?.fields.find((field) => kindOf(field) === 'number');

    if (targetField) {
      add('Лямбда any с условием', {
        $filter: `${collection.name}/any(x: x/${targetField.name} ge 0)`,
      });
      add('Лямбда all', {
        $filter: `${collection.name}/all(x: x/${targetField.name} ge 0)`,
      });
    }
  }

  // ── Отказы ────────────────────────────────────────────────────────────────
  // Библиотека никогда не выполняет запрос частично: непереводимая конструкция,
  // несуществующее поле и недопустимое значение параметра дают 400, а не тихую подмену
  // результата. Ради этого примеры-отказы и держатся на видном месте.
  // Смещение часового пояса не хранится, восстанавливать его не из чего — трансляции
  // у функции нет и не будет. Пример потому и выбран: он не устареет от того, что
  // перечень поддержанных функций пополнится.
  add('Функция без трансляции', { $filter: 'totaloffsetminutes(id) eq 0' }, true);
  add('Несуществующее поле', { $filter: 'nonexistent eq 1' }, true);
  add('Отрицательный $top', { $top: '-5' }, true);

  return examples;
}
