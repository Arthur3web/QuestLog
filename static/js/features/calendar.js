// ==========================================================
// Выезжающая панель календаря: месяц-сетка + задачи выбранного
// дня. Состояние панели локально для этого модуля.
// ==========================================================

import { byId, escapeHtml } from "../core/dom.js";
import { formatDate, toDateKey } from "../core/format.js";
import { state } from "../core/store.js";
import { isModalOpen } from "../core/modal.js";
import { openTaskModal } from "./task-modal.js";

let calendarOpen = false;
let calendarViewDate = new Date(); // отображаемый месяц
let calendarSelectedDate = toDateKey(new Date()); // выбранный день

function allTasksWithDueDate() {
  const tasks = [];
  state.columns.forEach((col) =>
    col.tasks.forEach((t) => {
      if (t.due_date) tasks.push(t);
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
      const dot = document.createElement("span");
      dot.className = "day-dot";
      cell.appendChild(dot);
    }
    cell.addEventListener("click", () => {
      calendarSelectedDate = key;
      render();
    });
    grid.appendChild(cell);
  }

  const dayTasks = (tasksByDay[calendarSelectedDate] || [])
    .slice()
    .sort((a, b) => a.priority.localeCompare(b.priority));
  byId("calendar-day-heading").textContent =
    `Задачи на ${formatDate(calendarSelectedDate)}`;

  const dayList = byId("calendar-day-list");
  dayList.innerHTML = "";
  if (!dayTasks.length) {
    dayList.innerHTML = `<span class="hint-text">На этот день задач нет.</span>`;
  } else {
    dayTasks.forEach((t) => {
      const row = document.createElement("div");
      row.className = "calendar-day-item";
      row.innerHTML = `
        <span class="priority-dot ${t.priority}"></span>
        <span class="title">${escapeHtml(t.title)}</span>
      `;
      row.addEventListener("click", () => {
        close();
        openTaskModal(t.id);
      });
      dayList.appendChild(row);
    });
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
