/**
 * Логика конструктора запросов.
 *
 * Без сборки и фреймворков: файл отдаётся статикой и работает как есть. Задача страницы —
 * показать связь между полями формы, итоговым URL и ответом сервера, поэтому URL
 * пересобирается на каждое изменение, а не только по нажатию кнопки.
 */

const form = {
  resource: document.getElementById('resource'),
  filter: document.getElementById('filter'),
  select: document.getElementById('select'),
  expand: document.getElementById('expand'),
  orderby: document.getElementById('orderby'),
  top: document.getElementById('top'),
  skip: document.getElementById('skip'),
  search: document.getElementById('search'),
  count: document.getElementById('count'),
};

const ui = {
  url: document.getElementById('url'),
  output: document.getElementById('output'),
  status: document.getElementById('status'),
  timing: document.getElementById('timing'),
  resourceHint: document.getElementById('resource-hint'),
  examples: document.getElementById('examples'),
};

/**
 * Схема сущностей: заполняется один раз при загрузке из `/api/$schema`.
 *
 * Не `/api/$metadata`: там лежит стандартный документ OData в CSDL XML, а конструктору
 * нужна собственная выжимка в JSON — имена полей и связей для подсказок.
 */
let schema = [];

/**
 * Готовые примеры.
 *
 * Подобраны так, чтобы покрыть и обычные сценарии, и три случая, ради которых
 * библиотека вообще отвергает запрос: неподдерживаемая конструкция, поле вне схемы
 * и превышение лимита страницы.
 */
const EXAMPLES = [
  {
    title: 'Фильтр и сортировка',
    resource: 'books',
    query: { $filter: 'pages gt 200', $orderby: 'title asc' },
  },
  {
    title: 'Выбор полей и связей',
    resource: 'books',
    query: { $select: 'id,title', $expand: 'author,publisher' },
  },
  {
    title: 'Вложенный $select внутри $expand',
    resource: 'books',
    query: { $select: 'id,title', $expand: 'author($select=name)' },
  },
  {
    title: 'Фильтр по полю связи',
    resource: 'books',
    query: { $filter: "author/name eq 'Ada'", $expand: 'author' },
  },
  {
    title: 'Связь «многие ко многим»',
    resource: 'books',
    query: { $filter: "tags/label eq 'classic'", $expand: 'tags' },
  },
  {
    title: 'Связь «один к одному»',
    resource: 'books',
    query: { $filter: 'details/isbn ne null', $expand: 'details' },
  },
  {
    title: 'Раздел внутри раздела — ссылка на саму себя',
    resource: 'categories',
    query: { $filter: "parent/name eq 'Science'", $expand: 'parent' },
  },
  {
    title: 'Путь через две связи',
    resource: 'books',
    query: { $filter: "category/parent/name eq 'Science'", $orderby: 'id asc' },
  },
  {
    title: 'Три уровня $expand',
    resource: 'authors',
    query: { $expand: 'books($expand=reviews($select=score))', $filter: 'id eq 1' },
  },
  {
    title: 'Вложенная пагинация внутри $expand',
    resource: 'authors',
    query: { $expand: 'books($orderby=id desc;$top=1)' },
  },
  {
    title: 'Отрицание — нужны явные скобки',
    resource: 'books',
    query: { $filter: "(not (title eq 'Orphan Book')) and id gt 1" },
  },
  {
    title: 'Арифметика',
    resource: 'books',
    query: { $filter: 'pages div 100 ge 3', $orderby: 'pages asc' },
  },
  {
    title: 'Строковые функции',
    resource: 'authors',
    query: { $filter: "length(name) gt 3 and startswith(name,'A')" },
  },
  {
    title: 'Функции даты',
    resource: 'authors',
    query: { $filter: 'year(registeredAt) eq 2020' },
  },
  {
    title: 'Пагинация со счётчиком',
    resource: 'books',
    query: { $orderby: 'id asc', $top: '2', $skip: '2', $count: 'true' },
  },
  {
    title: 'Поиск по всем полям',
    resource: 'authors',
    query: { $search: 'computing' },
  },
  {
    title: 'Пустая страница, только счётчик',
    resource: 'books',
    query: { $top: '0', $count: 'true' },
  },
  {
    title: 'Скрытая колонка — отвергается',
    resource: 'users',
    query: { $select: 'id,passwordHash' },
    expectError: true,
  },
  {
    title: 'Лямбда any — не поддерживается',
    resource: 'authors',
    query: { $filter: 'books/any(b: b/id eq 1)' },
    expectError: true,
  },
  {
    title: 'Несуществующее поле',
    resource: 'books',
    query: { $filter: 'nonexistent eq 1' },
    expectError: true,
  },
];

/** Собирает строку запроса из непустых полей формы. */
function buildQuery() {
  const params = new URLSearchParams();
  const add = (key, value) => {
    const trimmed = String(value ?? '').trim();

    if (trimmed !== '') {
      params.set(key, trimmed);
    }
  };

  add('$filter', form.filter.value);
  add('$select', form.select.value);
  add('$expand', form.expand.value);
  add('$orderby', form.orderby.value);
  add('$top', form.top.value);
  add('$skip', form.skip.value);
  add('$search', form.search.value);

  // Отсутствующий $count по спецификации означает false, поэтому в URL он появляется,
  // только когда пользователь его включил — так URL остаётся минимальным и честным.
  if (form.count.checked) {
    params.set('$count', 'true');
  }

  const query = params.toString();

  return `/api/${form.resource.value}${query ? `?${query}` : ''}`;
}

function refreshUrl() {
  ui.url.textContent = buildQuery();
}

/** Показывает поля и связи выбранной сущности — чтобы не держать схему в голове. */
function refreshResourceHint() {
  const resource = schema.find((item) => item.name === form.resource.value);

  if (!resource) {
    ui.resourceHint.textContent = '';

    return;
  }

  const fields = resource.fields.map((field) => field.name).join(', ');
  const relations = resource.relations.map((relation) => relation.name).join(', ');

  ui.resourceHint.textContent = relations
    ? `Поля: ${fields}. Связи: ${relations}.`
    : `Поля: ${fields}.`;
}

function setStatus(text, kind) {
  ui.status.textContent = text;
  ui.status.className = `status status--${kind}`;
}

async function run() {
  const url = buildQuery();

  setStatus('выполняется…', 'idle');
  ui.timing.textContent = '';

  const startedAt = performance.now();

  try {
    const response = await fetch(url);
    const elapsed = Math.round(performance.now() - startedAt);
    const body = await response.json();

    ui.output.textContent = JSON.stringify(body, null, 2);
    ui.timing.textContent = `${elapsed} мс`;

    // 400 здесь — штатный, а не аварийный исход: именно так библиотека сообщает,
    // что запрос выполнить нельзя, вместо того чтобы вернуть неполный результат.
    setStatus(`HTTP ${response.status}`, response.ok ? 'ok' : 'error');
  } catch (error) {
    ui.output.textContent = String(error);
    setStatus('сеть недоступна', 'error');
  }
}

function applyExample(example) {
  form.resource.value = example.resource;
  form.filter.value = example.query.$filter ?? '';
  form.select.value = example.query.$select ?? '';
  form.expand.value = example.query.$expand ?? '';
  form.orderby.value = example.query.$orderby ?? '';
  form.top.value = example.query.$top ?? '';
  form.skip.value = example.query.$skip ?? '';
  form.search.value = example.query.$search ?? '';
  form.count.checked = example.query.$count === 'true';

  refreshResourceHint();
  refreshUrl();
  run();
}

function renderExamples() {
  ui.examples.innerHTML = '';

  for (const example of EXAMPLES) {
    const item = document.createElement('li');
    const button = document.createElement('button');

    button.type = 'button';

    const title = document.createElement('span');

    title.className = 'example-title';
    title.textContent = example.title;

    if (example.expectError) {
      const tag = document.createElement('span');

      tag.className = 'tag tag--error';
      tag.textContent = '400';
      title.appendChild(tag);
    }

    const query = document.createElement('span');

    query.className = 'example-query';
    query.textContent = Object.entries(example.query)
      .map(([key, value]) => `${key}=${value}`)
      .join('&');

    button.append(title, query);
    button.addEventListener('click', () => applyExample(example));

    item.appendChild(button);
    ui.examples.appendChild(item);
  }
}

function reset() {
  for (const key of ['filter', 'select', 'expand', 'orderby', 'top', 'skip', 'search']) {
    form[key].value = '';
  }

  form.count.checked = false;

  ui.output.textContent = 'Нажмите «Выполнить», чтобы увидеть ответ.';
  setStatus('готов', 'idle');
  ui.timing.textContent = '';
  refreshUrl();
}

async function init() {
  try {
    schema = await (await fetch('/api/$schema')).json();
  } catch {
    schema = [];
  }

  for (const resource of schema) {
    const option = document.createElement('option');

    option.value = resource.name;
    option.textContent = `/api/${resource.name}`;
    form.resource.appendChild(option);
  }

  // Пересборка URL на любое изменение: она и есть главное, чему учит страница.
  for (const element of Object.values(form)) {
    element.addEventListener('input', refreshUrl);
    element.addEventListener('change', refreshUrl);
  }

  form.resource.addEventListener('change', refreshResourceHint);

  document.getElementById('run').addEventListener('click', run);
  document.getElementById('reset').addEventListener('click', reset);
  document.getElementById('copy').addEventListener('click', async () => {
    await navigator.clipboard.writeText(new URL(buildQuery(), location.origin).toString());
  });

  renderExamples();
  refreshResourceHint();
  refreshUrl();
}

init();
