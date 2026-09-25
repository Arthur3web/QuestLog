// ==========================================================
// Выезжающая панель календаря: месяц-сетка + задачи выбранного
// дня. Состояние панели локально для этого модуля.
// ==========================================================

import { byId, escapeHtml } from "../core/dom.js";
import { formatDate, toDateKey, isOverdue, isDueSoon, daysUntil } from "../core/format.js";
import { state } from "../domain/store.js";
import { PRIORITY_ORDER } from "../core/config.js";
import { isModalOpen } from "../core/modal.js";
import { openTaskModal } from "./task-modal.js";

let calendarOpen = false;
let calendarViewDate = new Date(); // отображаемый месяц
let calendarSelectedDate = toDateKey(new Date()); // выбранный день
let calendarFilter = "all"; // фильтр списка дня: all | soon | overdue | done

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

function resetCalendarView() {
  // Каждое открытие начинается заново: текущий месяц, сегодняшняя дата
  // и полный список дня. Последняя выбранная дата/фильтр не сохраняются.
  const now = new Date();
  calendarViewDate = new Date(now.getFullYear(), now.getMonth(), 1);
  calendarSelectedDate = toDateKey(now);
  calendarFilter = "all";
  byId("calendar-filters").querySelectorAll(".cal-filter").forEach((button) => {
    button.classList.toggle("active", button.dataset.calFilter === "all");
  });
}

function open() {
  calendarOpen = true;
  resetCalendarView();
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

function buildMonthGrid(tasksByDay) {
  const year = calendarViewDate.getFullYear();
  const month = calendarViewDate.getMonth();
  byId("calendar-month-label").textContent = calendarViewDate.toLocaleDateString("ru-RU", {
    month: "long", year: "numeric",
  });

  const grid = byId("calendar-grid");
  grid.innerHTML = "";
  ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].forEach((weekday) => {
    const element = document.createElement("div");
    element.className = "calendar-weekday";
    element.textContent = weekday;
    grid.appendChild(element);
  });

  const startDate = new Date(year, month, 1 - ((new Date(year, month, 1).getDay() + 6) % 7));
  const todayKey = toDateKey(new Date());
  for (let index = 0; index < 42; index++) {
    const date = new Date(startDate);
    date.setDate(startDate.getDate() + index);
    const key = toDateKey(date);
    const cell = document.createElement("div");
    cell.className = "calendar-day";
    if (date.getMonth() !== month) cell.classList.add("other-month");
    if (key === todayKey) cell.classList.add("today");
    if (key === calendarSelectedDate) cell.classList.add("selected");
    cell.textContent = date.getDate();

    const tasks = tasksByDay[key] || [];
    const active = tasks.filter((task) => !task.isDone);
    if (active.length && isDueSoon(key, 1)) cell.classList.add("due-soon-day");
    if (active.length && isOverdue(key)) cell.classList.add("overdue-day");
    if (tasks.length) {
      const dots = document.createElement("span");
      dots.className = "day-dots";
      for (let dotIndex = 0; dotIndex < Math.min(tasks.length - active.length, 3); dotIndex++) {
        const dot = document.createElement("span");
        dot.className = "day-dot done";
        dots.appendChild(dot);
      }
      for (let dotIndex = 0; dotIndex < Math.min(active.length, 3); dotIndex++) {
        const dot = document.createElement("span");
        dot.className = "day-dot";
        dots.appendChild(dot);
      }
      cell.appendChild(dots);
    }
    cell.addEventListener("click", () => {
      if (cell.classList.contains("other-month")) {
        calendarViewDate = new Date(date.getFullYear(), date.getMonth(), 1);
      }
      calendarSelectedDate = key;
      render();
    });
    grid.appendChild(cell);
  }
}

function badgeFor(task, carried) {
  if (carried) return `<span class="due-badge">${-daysUntil(task.due_date)} дн.</span>`;
  if (!task.isDone && isOverdue(task.due_date)) return '<span class="due-badge">просрочена</span>';
  if (!task.isDone && isDueSoon(task.due_date, 1)) return '<span class="due-badge soon">горит</span>';
  return "";
}

function computeDayRows(tasksByDay) {
  const dayTasks = (tasksByDay[calendarSelectedDate] || []).slice().sort((a, b) => {
    if (a.isDone !== b.isDone) return a.isDone ? 1 : -1;
    const aOver = !a.isDone && isOverdue(a.due_date) ? 1 : 0;
    const bOver = !b.isDone && isOverdue(b.due_date) ? 1 : 0;
    if (aOver !== bOver) return bOver - aOver;
    const pa = PRIORITY_ORDER.indexOf(a.priority);
    const pb = PRIORITY_ORDER.indexOf(b.priority);
    return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);
  });
  const dayIds = new Set(dayTasks.map((task) => task.id));
  const carriedOver = Object.values(tasksByDay).flat().filter((task) =>
    !task.isDone && isOverdue(task.due_date) && task.due_date < calendarSelectedDate && !dayIds.has(task.id),
  );
  const isFiltered = calendarFilter !== "all";
  let rows = [];
  if (isFiltered && calendarFilter === "soon") {
    rows = dayTasks.filter((task) => !task.isDone && isDueSoon(task.due_date, 1)).map((task) => ({ task }));
  } else if (isFiltered && calendarFilter === "overdue") {
    rows = [...dayTasks, ...carriedOver]
      .filter((task) => !task.isDone && isOverdue(task.due_date))
      .sort((a, b) => a.due_date.localeCompare(b.due_date))
      .map((task) => ({ task, badge: badgeFor(task, true) }));
  } else if (isFiltered && calendarFilter === "done") {
    rows = dayTasks.filter((task) => task.isDone).map((task) => ({ task }));
  } else {
    rows = dayTasks.map((task) => ({ task, badge: badgeFor(task, false) }));
    rows.push(...carriedOver.map((task) => ({ task, badge: badgeFor(task, true), carried: true })));
  }
  return { rows, dayTasks, carriedOver, isFiltered };
}

function renderDayList({ rows, dayTasks, carriedOver, isFiltered }) {
  const filterLabel = { soon: "Горящие", overdue: "Просроченные", done: "Готовые" }[calendarFilter];
  byId("calendar-day-heading").textContent = filterLabel
    ? `${filterLabel} · ${formatDate(calendarSelectedDate)}`
    : `Задачи на ${formatDate(calendarSelectedDate)}`;
  const dayList = byId("calendar-day-list");
  dayList.innerHTML = "";
  if (!rows.length) {
    dayList.innerHTML = `<span class="hint-text">${dayTasks.length || carriedOver.length ? "Под фильтр ничего не подходит." : "На этот день задач нет."}</span>`;
    return;
  }
  rows.forEach(({ task, badge, carried }) => {
    if (!isFiltered && carried && !dayList.querySelector(".calendar-overdue-heading")) {
      const heading = document.createElement("div");
      heading.className = "calendar-overdue-heading";
      heading.textContent = `Просроченные из прошлых дней (${carriedOver.length})`;
      dayList.appendChild(heading);
    }
    const row = document.createElement("div");
    row.className = "calendar-day-item" + (task.isDone ? " done" : "");
    row.innerHTML = `<span class="priority-dot ${task.priority}${!task.isDone && isOverdue(task.due_date) ? " overdue" : ""}"></span><span class="title">${escapeHtml(task.title)}</span>${badge || ""}`;
    row.addEventListener("click", () => { close(); openTaskModal(task.id); });
    dayList.appendChild(row);
  });
}

function render() {
  const tasksByDay = Object.create(null);
  allTasksWithDueDate().forEach((task) => {
    (tasksByDay[task.due_date] ||= []).push(task);
  });
  buildMonthGrid(tasksByDay);
  renderDayList(computeDayRows(tasksByDay));
}

export function bindCalendar() {
  byId("calendar-toggle-btn").addEventListener("click", () => {
    if (calendarOpen) close();
    else open();
  });
  byId("calendar-close-btn").addEventListener("click", close);
  byId("calendar-overlay").addEventListener("click", close);

  // Фильтр списка задач дня
  byId("calendar-filters").addEventListener("click", (e) => {
    const btn = e.target.closest(".cal-filter");
    if (!btn) return;
    calendarFilter = btn.dataset.calFilter;
    byId("calendar-filters").querySelectorAll(".cal-filter")
      .forEach((b) => b.classList.toggle("active", b === btn));
    render();
  });
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
