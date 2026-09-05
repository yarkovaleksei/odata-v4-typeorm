-- Данные для тестов. Загружаются заново перед каждым тестом (см. setup.ts),
-- поэтому идентификаторы фиксированные — на них можно опираться в ожиданиях.
--
-- Разделитель запросов — ";" в конце строки (см. loadSqlFile), так что каждый INSERT
-- обязан заканчиваться точкой с запятой на своей строке.

-- ── Базовый набор: User / Post ───────────────────────────────────────────────
INSERT INTO "user" ("id", "name", "email") VALUES
  (1, 'Alice', 'alice@example.com'),
  (2, 'Bob', 'bob@example.com');

INSERT INTO "post" ("id", "title", "content", "userId") VALUES
  (1, 'Alice first post', 'First post of Alice', 1),
  (2, 'Alice second post', 'Second post of Alice', 1),
  (3, 'Bob first post', 'First post of Bob', 2),
  (4, 'Bob second post', 'Second post of Bob', 2);

-- ── Набор для матрицы OData: Author / Book / Review ──────────────────────────
--
-- Значения подобраны так, чтобы каждый оператор давал непустую и при этом
-- НЕ полную выборку — иначе тест не отличит рабочий фильтр от отброшенного:
--
--   id  name      age  rating  isActive  registeredAt         bio
--   1   Ada       36   4.5     1         2020-01-15 10:30:00  'Pioneer of computing'
--   2   Grace     45   4.9     1         2021-06-01 08:00:00  NULL
--   3   Alan      41   3.2     0         NULL                 'Codebreaker'
--   4   Barbara   29   4.5     1         2022-03-20 12:00:00  NULL
INSERT INTO "author" ("id", "name", "age", "rating", "isActive", "registeredAt", "bio") VALUES
  (1, 'Ada',     36, 4.5, 1, '2020-01-15 10:30:00', 'Pioneer of computing'),
  (2, 'Grace',   45, 4.9, 1, '2021-06-01 08:00:00', NULL),
  (3, 'Alan',    41, 3.2, 0, NULL,                  'Codebreaker'),
  (4, 'Barbara', 29, 4.5, 1, '2022-03-20 12:00:00', NULL);

-- Книга 5 намеренно без автора: проверяет, что $expand делает LEFT JOIN, а не INNER.
INSERT INTO "book" ("id", "title", "pages", "authorId") VALUES
  (1, 'Analytical Engine', 300, 1),
  (2, 'Notes on Numbers',  120, 1),
  (3, 'Compiler Theory',   450, 2),
  (4, 'Enigma Machines',   210, 3),
  (5, 'Orphan Book',        90, NULL);

INSERT INTO "review" ("id", "text", "score", "bookId") VALUES
  (1, 'Brilliant work',   5, 1),
  (2, 'Hard but worth it', 4, 1),
  (3, 'Concise',          3, 2),
  (4, 'Foundational',     5, 3),
  (5, 'Dry',              2, 4);
