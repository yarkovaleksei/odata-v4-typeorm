/**
 * @file Тесты конструкторов типизированных ошибок.
 *
 * Сообщение и поле `position` собираются в конструкторе из того, что отдал парсер, а отдаёт
 * он не всегда одно и то же: иногда `Error` с позицией в тексте, иногда `Error` без неё,
 * иногда — вообще не `Error`. Раньше проверялся только первый случай, и остальные три ветки
 * сборки сообщения работали вслепую. Ошибка при формировании текста ошибки не всплывает
 * нигде: она маскирует ту ошибку, о которой сообщает.
 */
import { ODataParseError } from './ODataParseError';
import { ODataUnsupportedError } from './ODataUnsupportedError';

describe('ODataParseError', () => {
  it('позиция из сообщения парсера попадает в поле и в текст', () => {
    const error = new ODataParseError('$filter=!!!', new Error('Unexpected character at 8'));

    expect(error.position).toBe(8);
    expect(error.message).toContain('at position 8');
    expect(error.message).toContain('Unexpected character at 8');
    expect(error.isClientError).toBe(true);
  });

  it('причина без позиции оставляет position пустым', () => {
    // Парсер сообщает позицию не всегда: `fail()` её добавляет, а исключение из глубины —
    // нет. Позиции нет — в сообщении не должно появиться «at position undefined».
    const error = new ODataParseError('$filter=x', new Error('что-то пошло не так'));

    expect(error.position).toBeUndefined();
    expect(error.message).not.toContain('at position');
    expect(error.message).toContain('(что-то пошло не так)');
  });

  it('причина не типа Error приводится к строке', () => {
    // `throw 'строка'` в чужом коде — законный JavaScript, и до конструктора он доходит
    // в неизменном виде.
    const error = new ODataParseError('$filter=x', 'сломалось at 3');

    expect(error.position).toBe(3);
    expect(error.message).toContain('(сломалось at 3)');
  });

  it('без причины сообщение состоит из одного исходного выражения', () => {
    const error = new ODataParseError('$filter=x');

    expect(error.cause).toBeUndefined();
    expect(error.position).toBeUndefined();
    // Ни скобок пустой причины, ни позиции: '… "$filter=x"' и всё.
    expect(error.message).toBe('Failed to parse OData expression: "$filter=x"');
  });

  it('исходное выражение и причина остаются доступны для отладки', () => {
    const cause = new Error('at 1');
    const error = new ODataParseError('$filter=!', cause);

    expect(error.source).toBe('$filter=!');
    expect(error.cause).toBe(cause);
    expect(error.name).toBe('ODataParseError');
  });
});

describe('ODataUnsupportedError', () => {
  it('с фрагментом сообщение показывает, где именно споткнулись', () => {
    const error = new ODataUnsupportedError('geo.distance()', 'geo.distance(a,b) lt 1');

    expect(error.message).toBe(
      'OData feature is not supported: geo.distance() (in "geo.distance(a,b) lt 1")'
    );
    expect(error.fragment).toBe('geo.distance(a,b) lt 1');
  });

  it('без фрагмента сообщение ограничивается названием возможности', () => {
    // Фрагмент есть не у каждого отказа: имя узла AST приходит без исходного текста.
    const error = new ODataUnsupportedError('$apply');

    expect(error.message).toBe('OData feature is not supported: $apply');
    expect(error.fragment).toBeUndefined();
    expect(error.feature).toBe('$apply');
    expect(error.isClientError).toBe(true);
  });
});
