/**
 * @file Переключатель светлой и тёмной темы.
 *
 * ЦВЕТА ЗДЕСЬ НЕ ЗАДАЮТСЯ. Обе палитры записаны в `styles.css` через `light-dark()`,
 * а выбор темы меняет ровно один атрибут на `<html>`: дальше всё делает CSS. Поэтому
 * модуль ничего не знает о наборе токенов и не расходится с оформлением.
 *
 * ТРИ СОСТОЯНИЯ, А НЕ ДВА. Пока пользователь не нажимал кнопку, тема следует системной
 * и меняется вместе с ней — это состояние и есть отсутствие атрибута. Первое же нажатие
 * фиксирует выбор в `localStorage`, и системная тема перестаёт на страницу влиять.
 *
 * До первой отрисовки сохранённый выбор применяет строчный скрипт в `<head>`: сюда
 * управление приходит уже после того, как страница нарисована, и мигание темой
 * пришлось бы ловить глазами.
 */
import { ui } from './dom.js';

type Theme = 'light' | 'dark';

/** Ключ в `localStorage`; то же имя читает строчный скрипт в `index.html`. */
const STORAGE_KEY = 'theme';

/** Тёмная ли тема сейчас в системе. */
function systemPrefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Какая тема показана сейчас: выбранная пользователем либо системная. */
function currentTheme(): Theme {
  const chosen = document.documentElement.dataset['theme'];

  if (chosen === 'light' || chosen === 'dark') {
    return chosen;
  }

  return systemPrefersDark() ? 'dark' : 'light';
}

/**
 * Обновляет надпись на кнопке.
 *
 * На кнопке написано, куда она переключит, а не что показано сейчас: у второго прочтения
 * нет очевидного ответа на вопрос «нажать, чтобы стало как?».
 */
function renderButton(): void {
  const nextIsDark = currentTheme() === 'light';

  ui.theme.textContent = nextIsDark ? '🌙 Тёмная тема' : '☀️ Светлая тема';
  ui.theme.title = nextIsDark ? 'Переключить на тёмную тему' : 'Переключить на светлую тему';
}

/** Запоминает выбор; недоступное хранилище не должно ломать саму смену темы. */
function remember(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Приватный режим или запрет на данные сайтов: тема сменится, но не переживёт перезагрузку.
  }
}

/** Включает кнопку темы. Вызывается один раз при старте страницы. */
export function initTheme(): void {
  renderButton();

  ui.theme.addEventListener('click', () => {
    const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';

    document.documentElement.dataset['theme'] = next;
    remember(next);
    renderButton();
  });

  // Пока выбор не сделан, страница следует за системой — значит, и надпись на кнопке
  // обязана меняться вместе с ней, иначе она станет обещать то, что уже сделано.
  window
    .matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', () => renderButton());
}
