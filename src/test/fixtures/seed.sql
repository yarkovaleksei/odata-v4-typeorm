-- Единый набор данных для тестов и демо-сервера.
--
-- ОДИН ФАЙЛ НА ТРИ СУБД. Выполняется как есть на SQLite, PostgreSQL и MySQL, поэтому
-- подчиняется правилам, общим для всех трёх:
--
--   * идентификаторы только в нижнем регистре и без кавычек. PostgreSQL приводит некавыченный
--     идентификатор к нижнему регистру, а кавычки в MySQL означают строку, поэтому
--     единственная общая форма — snake_case без кавычек. Её обеспечивает
--     SnakeCaseNamingStrategy (см. namingStrategy.ts);
--   * никаких зарезервированных слов в именах таблиц. Отсюда app_user вместо user;
--   * булевы значения словами TRUE / FALSE: PostgreSQL не принимает для boolean 1 и 0;
--   * дата и время строкой 'YYYY-MM-DD HH:MM:SS' — её понимают все три;
--   * только ASCII. Кодировка соединения у MySQL зависит от настроек сервера,
--     и данные не то место, где стоит это выяснять;
--   * ни одного символа ; внутри значений — по нему файл разбивается на команды;
--   * ни одной последовательности -- внутри значений — так начинается комментарий.
--
-- ЗДЕСЬ ТОЛЬКО ДАННЫЕ, БЕЗ DDL. Переносимого CREATE TABLE для трёх СУБД не существует:
-- автоинкремент пишется как AUTOINCREMENT, SERIAL и AUTO_INCREMENT, а типы boolean
-- и datetime у каждой свои. Схему создаёт TypeORM по декораторам сущностей
-- (synchronize), и она заведомо согласована с ними — чего файл с DDL не гарантировал бы.
--
-- ЗНАЧЕНИЯ ПОДОБРАНЫ так, чтобы каждый оператор давал непустую и при этом НЕ полную
-- выборку: иначе тест не отличит работающий фильтр от отброшенного. Идентификаторы
-- заданы явно, потому что ожидания матрицы записаны именно ими.

-- ── Пользователи ────────────────────────────────────────────────────────────
-- password_hash помечен select: false и не должен покидать сервер ни по одному пути.
INSERT INTO app_user (id, name, email, password_hash) VALUES
  (1, 'Alice', 'alice@example.com', 'scrypt$alice$00000000'),
  (2, 'Bob', 'bob@example.com', 'scrypt$bob$11111111');

-- ── Публикации ──────────────────────────────────────────────────────────────
INSERT INTO post (id, title, content, user_id) VALUES
  (1, 'Alice first post', 'First post of Alice', 1),
  (2, 'Alice second post', 'Second post of Alice', 1),
  (3, 'Bob first post', 'First post of Bob', 2),
  (4, 'Bob second post', 'Second post of Bob', 2);

-- ── Издательства ────────────────────────────────────────────────────────────
-- Единственное место с типами date и decimal.
INSERT INTO publisher (id, name, country, founded_on, royalty_rate) VALUES
  (1, 'Clarendon Press', 'GB', '1586-01-01', 12.50),
  (2, 'MIT Press', 'US', '1962-06-15', 9.75),
  (3, 'Manning Digital', 'US', '1990-11-30', 7.00);

-- ── Разделы каталога ────────────────────────────────────────────────────────
-- Корни отдельной командой: MySQL проверяет внешний ключ построчно, и ссылка
-- на родителя из той же команды сработала бы только по счастливому порядку строк.
INSERT INTO category (id, name, parent_id) VALUES
  (1, 'Science', NULL),
  (4, 'Fiction', NULL);

INSERT INTO category (id, name, parent_id) VALUES
  (2, 'Mathematics', 1),
  (3, 'Computing', 1);

-- ── Авторы ──────────────────────────────────────────────────────────────────
--   id  name      age  rating  is_active  registered_at        bio
--   1   Ada       36   4.25    TRUE       2020-01-15 10:30:00  'Pioneer of computing'
--   2   Grace     45   4.9     TRUE       2021-06-01 08:00:00  NULL
--   3   Alan      41   3.2     FALSE      NULL                 'Codebreaker'
--   4   Barbara   29   4.25    TRUE       2022-03-20 12:00:00  NULL
--
-- ПРО ДАТЫ. Прогон идёт в UTC (process.env.TZ в jest.config.js), поэтому локальные
-- составляющие совпадают с UTC. Это принципиально: колонка объявлена без часового пояса,
-- но драйверы обращаются с ней по-разному, и без общей зоны hour(registeredAt) eq 8
-- давал бы разный результат на разных СУБД.
--
-- ПРО ДРОБНЫЕ. Значения намеренно без половинок: округление ровно 4.5 у СУБД разное.
INSERT INTO author (id, name, age, rating, is_active, registered_at, bio) VALUES
  (1, 'Ada', 36, 4.25, TRUE, '2020-01-15 10:30:00', 'Pioneer of computing'),
  (2, 'Grace', 45, 4.9, TRUE, '2021-06-01 08:00:00', NULL),
  (3, 'Alan', 41, 3.2, FALSE, NULL, 'Codebreaker'),
  (4, 'Barbara', 29, 4.25, TRUE, '2022-03-20 12:00:00', NULL);

-- ── Книги ───────────────────────────────────────────────────────────────────
-- Книга 5 намеренно без автора и без раздела: проверяет, что $expand делает
-- LEFT JOIN, а не INNER. Издательство есть у всех — связь объявлена обязательной.
INSERT INTO book (id, title, pages, author_id, publisher_id, category_id) VALUES
  (1, 'Analytical Engine', 300, 1, 1, 3),
  (2, 'Notes on Numbers', 120, 1, 1, 2),
  (3, 'Compiler Theory', 450, 2, 2, 3),
  (4, 'Enigma Machines', 210, 3, 2, 3),
  (5, 'Orphan Book', 90, NULL, 3, NULL);

-- ── Выходные данные ─────────────────────────────────────────────────────────
-- Есть не у всех книг: связь «один к одному» обязана давать null там, где записи нет.
INSERT INTO book_details (id, isbn, summary, release_time, book_id) VALUES
  (1, '9780000000001', 'A machine that never was', '09:00:00', 1),
  (2, NULL, 'Short notes on numeric methods', NULL, 2),
  (3, '9780000000003', NULL, '18:45:00', 3);

-- ── Метки ───────────────────────────────────────────────────────────────────
INSERT INTO tag (id, label) VALUES
  (1, 'classic'),
  (2, 'reference'),
  (3, 'history'),
  (4, 'unread');

-- Книга 5 не помечена ничем: пустая коллекция в $expand тоже должна работать.
INSERT INTO book_tag (book_id, tag_id) VALUES
  (1, 1),
  (1, 2),
  (2, 2),
  (3, 1),
  (3, 3),
  (4, 3);

-- ── Рецензии ────────────────────────────────────────────────────────────────
-- Рецензия 5 без автора: ещё один LEFT JOIN и ещё один IS NULL.
INSERT INTO review (id, text, score, book_id, user_id) VALUES
  (1, 'Brilliant work', 5, 1, 1),
  (2, 'Hard but worth it', 4, 1, 2),
  (3, 'Concise', 3, 2, 1),
  (4, 'Foundational', 5, 3, 2),
  (5, 'Dry', 2, 4, NULL);
