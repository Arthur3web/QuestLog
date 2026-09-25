// ==========================================================
// Тема оформления.
//
// Тема — это ТОЛЬКО CSS: всё, чем одна тема отличается от другой,
// описано в static/style.css под селектором html[data-theme="..."],
// а этот модуль решает, какой атрибут поставить на <html>, и
// запоминает выбор пользователя.
//
// Список доступных тем берётся из самого селектора в разметке:
// чтобы добавить третью тему, достаточно добавить <option> в
// index.html и блок html[data-theme="..."] в style.css — правок
// в JS не требуется.
// ==========================================================

import { byId } from "../core/dom.js";
import { LS_KEYS } from "../core/config.js";

// Первая тема в списке — тема по умолчанию: её токены лежат в :root,
// поэтому при неизвестном значении атрибута страница выглядит как обычно.
export const DEFAULT_THEME = "retro";

function themeSelect() {
  return byId("theme-select");
}

// Значения тем, объявленные в разметке (подписи и эмодзи — тоже там)
export function availableThemes() {
  const select = themeSelect();
  if (!select) return [DEFAULT_THEME];
  return Array.from(select.options).map(o => o.value);
}

function isKnownTheme(value) {
  return availableThemes().includes(value);
}

// Сохранённый выбор; мусор в хранилище трактуем как «тема по умолчанию»
export function currentTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem(LS_KEYS.theme);
  } catch (e) {
    // приватный режим или отключённое хранилище — молча работаем без него
  }
  return isKnownTheme(saved) ? saved : DEFAULT_THEME;
}

// Применяет тему к документу и сохраняет выбор
export function applyTheme(value) {
  const theme = isKnownTheme(value) ? value : DEFAULT_THEME;
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(LS_KEYS.theme, theme);
  } catch (e) {}
  return theme;
}

// Включает селектор тем в подвале: показывает текущую тему и слушает смену
export function bindTheme() {
  const select = themeSelect();
  if (!select) return;

  select.disabled = false;
  select.value = currentTheme();
  select.addEventListener("change", e => applyTheme(e.target.value));
}
