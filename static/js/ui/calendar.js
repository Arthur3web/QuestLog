// ==========================================================
// Выезжающая панель календаря: месяц-сетка + задачи выбранного
// дня. Состояние панели локально для этого модуля.
// ==========================================================

import { byId, escapeHtml } from "../core/dom.js";
import { formatDate, toDateKey, isOverdue, isDueSoon, daysUntil } from "../core/format.js";
import { state } from "../domain/store.js";
import { isModalOpen } from "../core/modal.js";
import { openTaskModal } from "./task-modal.js";

let calendarOpen = false;
let calendarViewDate = new Date(); // отображаемый месяц
let calendarSelectedDate = toDateKey(new Date()); // выбранный день

// id колонок, считающихся завершёнными (Done/Cancelled — is_done_state)
function doneColumnIds() {
  return new Set(state.columns.filter((c) => c.is_done_state).map((c) => c.id));
}

function allTasksWithDueDate() {
  const doneCols = doneColumnIds();
  const tasks = [];
  state.columns.forEach((col) =>
    col.tasks.forEach((t) => {
      if (t.due_date) tasks.push({ ...t, isDone: doneCols.has(t.column_id) });
    }),
  );
  return tasks;
}

function open() {
  calendarOpen = true;
  byId("calendar-panel").classList.add("open");
  const overlay = byId("calendar-overlay");
  overlay.classList.remove("hidden");
  requestAnimationFrame(() => overlay.classList.add("open"));
  render();
}

function close() {
  calendarOpen = false;
  byId("calendar-panel").classList.remove("open");
  const overlay = byId("calendar-overlay");
  overlay.classList.remove("open");
  setTimeout(() => {
    if (!calendarOpen) overlay.classList.add("hidden");
  }, 220);
}

function render() {
  const year = calendarViewDate.getFullYear();
  const month = calendarViewDate.getMonth();
  byId("calendar-month-label").textContent =
    calendarViewDate.toLocaleDateString("ru-RU", {
      month: "long",
      year: "numeric",
    });

  const tasksByDay = {};
  allTasksWithDueDate().forEach((t) => {
    (tasksByDay[t.due_date] = tasksByDay[t.due_date] || []).push(t);
  });

  const grid = byId("calendar-grid");
  grid.innerHTML = "";
  ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].forEach((w) => {
    const el = document.createElement("div");
    el.className = "calendar-weekday";
    el.textContent = w;
    grid.appendChild(el);
  });

  const firstOfMonth = new Date(year, month, 1);
  const startOffset = (firstOfMonth.getDay() + 6) % 7; // Пн = 0
  const startDate = new Date(year, month, 1 - startOffset);
  const todayKey = toDateKey(new Date());

  for (let i = 0; i < 42; i++) {
    const d = new Date(startDate);
    d.setDate(startDate.getDate() + i);
    const key = toDateKey(d);
    const cell = document.createElement("div");
    cell.className = "calendar-day";
    if (d.getMonth() !== month) cell.classList.add("other-month");
    if (key === todayKey) cell.classList.add("today");
    if (key === calendarSelectedDate) cell.classList.add("selected");
    cell.textContent = d.getDate();
    if (tasksByDay[key] && tasksByDay[key].length) {
      const tasks = tasksByDay[key];
      const active = tasks.filter((t) => !t.isDone);
      const doneCount = tasks.length - active.length;
      // Горящий день: срок сегодня/завтра и есть незавершённые задачи
      if (active.length && isDueSoon(key, 1)) cell.classList.add("due-soon-day");
      // Просроченный день: дата в прошлом и есть незавершённые задачи
      if (active.length && isOverdue(key)) cell.classList.add("overdue-day");
      // Точки: зелёные — завершённые, обычные — активные
      const dots = document.createElement("span");
      dots.className = "day-dots";
      for (let i = 0; i < Math.min(doneCount, 3); i++) {
        const dotEl = document.createElement("span");
        dotEl.className = "day-dot done";
        dots.appendChild(dotEl);
      }
      for (let i = 0; i < Math.min(active.length, 3); i++) {
        const dotEl = document.createElement("span");
        dotEl.className = "day-dot";
        dots.appendChild(dotEl);
      }
      cell.appendChild(dots);
    }
    cell.addEventListener("click", () => {
      calendarSelectedDate = key;
      render();
    });
    grid.appendChild(cell);
  }

  const dayTasks = (tasksByDay[calendarSelectedDate] || [])
    .slice()
    // сначала активные, из них — просроченные; завершённые в конец
    .sort((a, b) => {
      if (a.isDone !== b.isDone) return a.isDone ? 1 : -1;
      const aOver = !a.isDone && isOverdue(a.due_date) ? 1 : 0;
      const bOver = !b.isDone && isOverdue(b.due_date) ? 1 : 0;
      if (aOver !== bOver) return bOver - aOver;
      return a.priority.localeCompare(b.priority);
    });

  // Просроченные активные задачи — отдельным блоком под задачами дня:
  // пока не закрыты, они «переезжают» из прошлых дней в каждый следующий.
  const dayIds = new Set(dayTasks.map((t) => t.id));
  const carriedOver = allTasksWithDueDate().filter(
    (t) =>
      !t.isDone &&
      isOverdue(t.due_date) &&
      t.due_date < calendarSelectedDate &&
      !dayIds.has(t.id),
  );
  byId("calendar-day-heading").textContent =
    `Задачи на ${formatDate(calendarSelectedDate)}`;

  const dayList = byId("calendar-day-list");
  dayList.innerHTML = "";
  if (!dayTasks.length && !carriedOver.length) {
    dayList.innerHTML = `<span class="hint-text">На этот день задач нет.</span>`;
  } else {
    const appendRow = (t, { carried = false } = {}) => {
      const row = document.createElement("div");
      row.className = "calendar-day-item" + (t.isDone ? " done" : "");
      const overdue = !t.isDone && isOverdue(t.due_date);
      const dueSoon = !t.isDone && isDueSoon(t.due_date, 1);
      // В основном списке — бейдж «просрочена»; в блоке перенесённых он
      // избыточен (заголовок уже говорит об этом), там показываем на сколько дней.
      const lateDays = overdue ? -daysUntil(t.due_date) : 0;
      const badge = carried
        ? `<span class="due-badge">${lateDays} дн.</span>`
        : overdue
          ? '<span class="due-badge">просрочена</span>'
          : dueSoon
            ? '<span class="due-badge soon">горит</span>'
            : "";
      row.innerHTML = `
        <span class="priority-dot ${t.priority}${overdue ? " overdue" : ""}"></span>
        <span class="title">${escapeHtml(t.title)}</span>
        ${badge}
      `;
      row.addEventListener("click", () => {
        close();
        openTaskModal(t.id);
      });
      dayList.appendChild(row);
    };
    dayTasks.forEach(appendRow);
    if (carriedOver.length) {
      const head = document.createElement("div");
      head.className = "calendar-overdue-heading";
      head.textContent = `Просроченные из прошлых дней (${carriedOver.length})`;
      dayList.appendChild(head);
      carriedOver.forEach((t) => appendRow(t, { carried: true }));
    }
  }
}

export function bindCalendar() {
  byId("calendar-toggle-btn").addEventListener("click", () => {
    if (calendarOpen) close();
    else open();
  });
  byId("calendar-close-btn").addEventListener("click", close);
  byId("calendar-overlay").addEventListener("click", close);
  byId("calendar-prev-month").addEventListener("click", () => {
    calendarViewDate = new Date(
      calendarViewDate.getFullYear(),
      calendarViewDate.getMonth() - 1,
      1,
    );
    render();
  });
  byId("calendar-next-month").addEventListener("click", () => {
    calendarViewDate = new Date(
      calendarViewDate.getFullYear(),
      calendarViewDate.getMonth() + 1,
      1,
    );
    render();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && calendarOpen && !isModalOpen()) close();
  });
}
