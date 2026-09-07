/**
 * @file Опция `autoExpand`: дописывает в `$expand` все связи корневой сущности.
 *
 * Работа идёт над строкой `$expand`, а не над деревом `includes` уже скомпилированного запроса:
 * так автоматические связи проходят ровно тот же путь, что и присланные клиентом, — разбор
 * парсером, создание вложенных посетителей, `leftJoinAndSelect`, вложенная пагинация, снятие
 * невыбираемых колонок. Никакой второй ветки, которую пришлось бы поддерживать наравне
 * с основной, не появляется.
 *
 * ГЛУБИНА — ОДИН УРОВЕНЬ. Дописываются навигационные свойства самого корня, как у `$expand=*`
 * в OData v4 (раздел 11.2.5.2). Рекурсия вглубь здесь невозможна в принципе: связи почти всегда
 * образуют цикл (`Book.author` → `Author.books` → …), а у `Category` он замыкается на саму
 * сущность, и «все связи на всех уровнях» — бесконечное дерево. Связи следующих уровней
 * запрашиваются явно: `$expand=reviews($expand=book)` вместе с `autoExpand` работает.
 */
import type { EntityMetadata } from 'typeorm';

/**
 * Имя связи в одном сегменте `$expand`.
 *
 * Отрезаются вложенные опции (`books($top=2)` → `books`) и хвост пути
 * (`books/reviews` → `books`): сегмент считается «уже запрошенным» по своему первому шагу,
 * иначе связь получила бы второй, конкурирующий сегмент в том же `$expand`.
 */
function segmentName(segment: string): string {
  // `split` всегда возвращает хотя бы один элемент — приведение лишь снимает `| undefined`,
  // который добавляет `noUncheckedIndexedAccess`.
  const head = segment.split('(')[0] as string;

  return (head.split('/')[0] as string).trim();
}

/**
 * Имена связей верхнего уровня в строке `$expand`.
 *
 * Разбиение по запятым — вручную, а не `split(',')`: запятая встречается и внутри вложенных
 * опций (`books($filter=contains(title,'a'))`), и внутри строкового литерала. Поэтому счётчик
 * скобок и флаг кавычек. Литерал OData экранирует кавычку удвоением (`'it''s'`), и простое
 * переключение флага разбирает это верно: две кавычки подряд гасят друг друга.
 */
function topLevelNames(expand: string): string[] {
  const names: string[] = [];

  let depth = 0;
  let quoted = false;
  let start = 0;

  for (let index = 0; index < expand.length; index += 1) {
    const character = expand[index];

    if (quoted) {
      if (character === "'") {
        quoted = false;
      }

      continue;
    }

    if (character === "'") {
      quoted = true;
    } else if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth -= 1;
    } else if (character === ',' && depth === 0) {
      names.push(expand.slice(start, index));
      start = index + 1;
    }
  }

  names.push(expand.slice(start));

  return names.map(segmentName).filter((name) => name !== '');
}

/**
 * Дописывает к `$expand` связи корневой сущности, которых клиент не назвал.
 *
 * @param expand - исходное значение `$expand` (может отсутствовать).
 * @param metadata - метаданные корневой сущности: из них берётся перечень связей.
 * @param allowedExpands - белый список связей, если он задан в опциях. Автоматические связи
 *   фильтруются по нему, а не проверяются им: список ограничивает клиента, и запрос, в котором
 *   клиент ничего лишнего не просил, не должен отвергаться из-за того, что сервер сам дописал
 *   связь вне списка.
 * @returns новое значение `$expand`; исходное — если добавлять нечего.
 *
 * @remarks Связи, названные клиентом, остаются как есть вместе со своими вложенными опциями:
 *   `$expand=reviews($top=2)` при `autoExpand` даёт страницу отзывов, а не все отзывы.
 *
 * @remarks Связи внутри `@Embedded` пропускаются: их `propertyPath` содержит точку
 *   (`meta.author`), а грамматика `$expand` такой путь не описывает.
 *
 * @example
 * withAutoExpand('reviews($top=2)', bookMetadata);
 * // → 'reviews($top=2),author,publisher,category,tags,details'
 */
export function withAutoExpand(
  expand: string | undefined,
  metadata: EntityMetadata,
  allowedExpands?: readonly string[]
): string | undefined {
  const current = expand?.trim() ?? '';
  const requested = new Set(topLevelNames(current));

  const added = metadata.relations
    .map((relation) => relation.propertyPath)
    .filter((path) => !path.includes('.'))
    .filter((path) => !requested.has(path))
    .filter((path) => !allowedExpands || allowedExpands.includes(path));

  if (added.length === 0) {
    return expand;
  }

  return current ? `${current},${added.join(',')}` : added.join(',');
}
