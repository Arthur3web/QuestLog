// ==========================================================
// Тематический выбор даты.
//
// Нативный календарь input[type=date] рисует сам браузер — его
// нельзя оформить в стиле темы, поэтому Chrome/Edge показывают
// чужеродный светлый попап. Здесь мы оставляем сам input
// (значение по-прежнему ISO-строка YYYY-MM-DD, ради чего весь
// остальной код читает .value без изменений), прячем нативный
// индикатор и открываем свой календарь в стилистике приложения.
// ==========================================================

import { ICONS } from "../core/icons.js";

const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const MONTHS = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
];

let popup = null; // единственный попап на всё приложение
let activeInput = null; // input, для которого сейчас открыт попап
let viewDate = new Date(); // отображаемый месяц

function toKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseKey(key) {
  if (!key) return null;
  const [y, m, d] = key.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

// ------------------------------------------------------------
// Каркас попапа создаётся один раз и переиспользуется
// ------------------------------------------------------------
function ensurePopup() {
  if (popup) return popup;
  popup = document.createElement("div");
  popup.id = "date-picker-popup";
  popup.className = "date-picker-popup hidden";
  popup.innerHTML = `
    <div class="dp-head">
      <button type="button" class="dp-nav" data-dp="prev" title="Предыдущий месяц">${ICONS.chevronLeft}</button>
      <span class="dp-label"></span>
      <button type="button" class="dp-nav" data-dp="next" title="Следующий месяц">${ICONS.chevronRight}</button>
    </div>
    <div class="dp-grid"></div>
    <div class="dp-foot">
      <button type="button" class="dp-link" data-dp="clear">Очистить</button>
      <button type="button" class="dp-link" data-dp="today">Сегодня</button>
    </div>
  `;
  document.body.appendChild(popup);

  popup.addEventListener("click", (e) => {
    const nav = e.target.closest("[data-dp]");
    if (nav) {
      const action = nav.dataset.dp;
      if (action === "prev") { viewDate.setMonth(viewDate.getMonth() - 1); renderGrid(); }
      else if (action === "next") { viewDate.setMonth(viewDate.getMonth() + 1); renderGrid(); }
      else if (action === "clear") { commitValue(""); }
      else if (action === "today") { commitValue(toKey(new Date())); }
      return;
    }
    const day = e.target.closest(".dp-day");
    if (day && !day.classList.contains("other-month")) {
      commitValue(day.dataset.key);
    }
  });
  return popup;
}

function commitValue(key) {
  if (!activeInput) return;
  activeInput.value = key;
  // Сообщаем остальному коду, что значение изменилось (как change у input).
  activeInput.dispatchEvent(new Event("change", { bubbles: true }));
  closePicker();
}

function renderGrid() {
  const label = popup.querySelector(".dp-label");
  label.textContent = `${MONTHS[viewDate.getMonth()]} ${viewDate.getFullYear()}`;

  const grid = popup.querySelector(".dp-grid");
  grid.innerHTML = "";
  WEEKDAYS.forEach((w) => {
    const el = document.createElement("div");
    el.className = "dp-weekday";
    el.textContent = w;
    grid.appendChild(el);
  });

  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const startOffset = (firstOfMonth.getDay() + 6) % 7; // Пн = 0
  const startDate = new Date(year, month, 1 - startOffset);
  const todayKey = toKey(new Date());
  const selectedKey = activeInput ? activeInput.value : "";

  for (let i = 0; i < 42; i++) {
    const d = new Date(startDate);
    d.setDate(startDate.getDate() + i);
    const key = toKey(d);
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "dp-day";
    if (d.getMonth() !== month) cell.classList.add("other-month");
    if (key === todayKey) cell.classList.add("today");
    if (key === selectedKey) cell.classList.add("selected");
    cell.dataset.key = key;
    cell.textContent = d.getDate();
    grid.appendChild(cell);
  }
}

function positionPopup() {
  if (!activeInput || !popup) return;
  const r = activeInput.getBoundingClientRect();
  popup.classList.remove("hidden");
  const pw = popup.offsetWidth;
  const ph = popup.offsetHeight;
  let left = r.left;
  if (left + pw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - pw - 8);
  let top = r.bottom + 6;
  if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 6);
  popup.style.left = `${Math.round(left)}px`;
  popup.style.top = `${Math.round(top)}px`;
}

export function openDatePicker(input) {
  ensurePopup();
  activeInput = input;
  const base = parseKey(input.value) || new Date();
  viewDate = new Date(base.getFullYear(), base.getMonth(), 1);
  renderGrid();
  positionPopup();
  input.classList.add("dp-active");
}

export function closePicker() {
  if (activeInput) activeInput.classList.remove("dp-active");
  if (popup) popup.classList.add("hidden");
  activeInput = null;
}

// ------------------------------------------------------------
// Привязка: отключаем нативный календарь и открываем свой
// ------------------------------------------------------------
// Небольшая справка по выбору решения.
//
// input[type=date] в Chromium ВСЕГДА открывает свой нативный календарь
// при активации, и никакой CSS/overlay это не отменяет (событие фокуса
// вызывает его). Поэтому поле превращаем в type="text": нативного
// календаря больше нет вообще. Значение по-прежнему ISO-строка
// (как у type=date), поэтому весь остальной код, читающий .value,
// работает без изменений.
export function attachDatePicker(input) {
  if (!input || input.dataset.dpBound) return;
  input.dataset.dpBound = "1";

  input.type = "text";
  input.autocomplete = "off";
  input.readOnly = true;
  input.placeholder = input.placeholder || "ГГГГ-ММ-ДД";

  const wrap = input.parentElement;
  if (wrap && !wrap.querySelector(".dp-toggle")) {
    // Прозрачная накладка на всё поле — перехватывает клик
    const cover = document.createElement("button");
    cover.type = "button";
    cover.className = "dp-cover";
    cover.setAttribute("aria-label", "Выбрать дату");
    cover.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (activeInput === input) closePicker();
      else openDatePicker(input);
    });
    wrap.appendChild(cover);

    // Иконка календаря — визуальная подсказка (тоже открывает попап).
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dp-toggle";
    btn.title = "Выбрать дату";
    btn.innerHTML = ICONS.calendar;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (activeInput === input) closePicker();
      else openDatePicker(input);
    });
    wrap.appendChild(btn);
    wrap.classList.add("dp-field");
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
      e.preventDefault();
      openDatePicker(input);
    } else if (e.key === "Escape") {
      closePicker();
    }
  });
}

// Глобальные обработчики закрытия — один раз на приложение.
export function bindDatePickers() {
  document.addEventListener("click", (e) => {
    if (!activeInput) return;
    if (e.target.closest("#date-picker-popup") || e.target.closest(".dp-field")) return;
    closePicker();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && activeInput) closePicker();
  });
  window.addEventListener("resize", closePicker);
  window.addEventListener("scroll", closePicker, true);
}
