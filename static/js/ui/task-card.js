// ==========================================================
// Карточка задачи на доске + контекстное меню (ПКМ).
//
// Здесь только представление: как карточка и меню выглядят и
// какие элементы в них есть. Что происходит при выборе пункта —
// в context-menu-actions.js. Разделение не косметическое: раньше
// файл был один, и ошибка в одном действии валила весь граф
// модулей, оставляя пустую доску.
// ==========================================================

import { byId, escapeHtml, initials } from "../core/dom.js";
import { ICONS } from "../core/icons.js";
import { formatDate, isOverdue, isDueSoon, formatDuration, formatDurationShort } from "../core/format.js";
import { PRIORITY_LABEL } from "../core/config.js";
import { state, userById, findTaskById } from "../domain/store.js";
import { openTaskModal } from "./task-modal.js";
import * as actions from "./context-menu-actions.js";

let contextMenuTaskId = null;

// ------------------------------------------------------------
// Карточка
// ------------------------------------------------------------
export function renderCard(task) {
  const card = document.createElement("div");
  card.className = "card";
  card.draggable = true;
  card.dataset.taskId = task.id;

  const tagsHtml = task.tags.length
    ? `<div class="card-tags">${task.tags.map((t) => `<span class="tag-chip">${escapeHtml(t)}</span>`).join("")}</div>`
    : "";

  const assignee = userById(task.assignee_id);
  const assigneeHtml = assignee
    ? `<div class="avatar" style="width:18px;height:18px;font-size:9px;background:${assignee.color}" title="${escapeHtml(assignee.name)}">${initials(assignee.name)}</div>`
    : "";

  // Срок: просрочен — красный, сегодня/завтра — жёлтый, иначе нейтральный.
  // Для завершённых задач (колонка is_done_state) срок больше не подсвечивается:
  // закрытая вовремя задача — не просроченная.
  const doneCols = new Set(state.columns.filter((c) => c.is_done_state).map((c) => c.id));
  const taskDone = doneCols.has(task.column_id);
  const dueClass = task.due_date && !taskDone
    ? isOverdue(task.due_date)
      ? "overdue"
      : isDueSoon(task.due_date)
        ? "due-soon"
        : ""
    : null;
  // Время: на карточке показываем справа, если есть учтённое время
  // или идёт таймер — в футере, после распорки .spacer.
  const timeHtml = task.time_spent_seconds > 0 || task.timer_running
    ? `<span class="card-time${task.timer_running ? " timer-running" : ""}" title="${escapeHtml(task.timer_running ? "Идёт таймер" : `Затрачено: ${formatDuration(task.time_spent_seconds)}`)}">${ICONS.timer}<span>${formatDurationShort(task.time_spent_seconds)}</span></span>`
    : "";

  // Срок — отдельной строкой под заголовком/тегами, время уходит вправо.
  const dueHtml = task.due_date
    ? `<div class="card-due-row">
         <span class="card-due ${dueClass}"><span class="card-due-label">Срок:</span> ${formatDate(task.due_date)}</span>
       </div>`
    : "";

  card.innerHTML = `
    <div class="card-title">${escapeHtml(task.title)}</div>
    ${tagsHtml}
    ${dueHtml}
    <div class="card-footer">
      <span class="priority-dot ${task.priority}"></span>
      <span class="priority-label">${PRIORITY_LABEL[task.priority] || task.priority}</span>
      <span class="spacer"></span>
      ${task.subtasks_total ? `<span class="mini-meta">${ICONS.subtasks}<span>${task.subtasks_done}/${task.subtasks_total}</span></span>` : ""}
      ${task.comments_count ? `<span class="mini-meta">${ICONS.comment}<span>${task.comments_count}</span></span>` : ""}
      ${task.attachments_count ? `<span class="mini-meta">${ICONS.attachment}<span>${task.attachments_count}</span></span>` : ""}
      ${timeHtml}
      ${assigneeHtml}
    </div>
  `;

  card.addEventListener("click", () => openTaskModal(task.id));
  // ПКМ по карточке — контекстное меню: менять задачу, не открывая её
  card.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openContextMenu(task.id, e.clientX, e.clientY);
  });
  card.addEventListener("dragstart", (e) => {
    card.classList.add("dragging");
    e.dataTransfer.setData("text/plain", String(task.id));
  });
  card.addEventListener("dragend", () => card.classList.remove("dragging"));

  return card;
}

// ------------------------------------------------------------
// Контекстное меню
// ------------------------------------------------------------
function openContextMenu(taskId, x, y) {
  const task = findTaskById(taskId);
  if (!task) return;
  contextMenuTaskId = taskId;

  const menu = byId("task-context-menu");

  // Поля заполняются текущими значениями задачи
  byId("cm-priority").value = task.priority;

  const assigneeSel = byId("cm-assignee");
  assigneeSel.innerHTML =
    `<option value="">Без исполнителя</option>` +
    state.users
      .map((u) => `<option value="${u.id}">${escapeHtml(u.name)}</option>`)
      .join("");
  assigneeSel.value = task.assignee_id || "";

  byId("cm-due").value = task.due_date || "";

  const columnSel = byId("cm-column");
  columnSel.innerHTML = state.columns
    .map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`)
    .join("");
  columnSel.value = task.column_id;

  // Форма подзадачи всегда свёрнута при повторном открытии
  byId("cm-subtask-form").classList.add("hidden");
  byId("cm-subtask-input").value = "";

  // Показываем и замеряем, чтобы меню не вышло за границы окна
  menu.classList.remove("hidden");
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
}

export function closeContextMenu() {
  byId("task-context-menu").classList.add("hidden");
  contextMenuTaskId = null;
}

// id задачи нужно прочитать ДО закрытия меню — closeContextMenu() обнуляет
// contextMenuTaskId, и переданное после этого значение уже потеряно.
function currentId() {
  return contextMenuTaskId;
}

// ------------------------------------------------------------
// Привязка событий меню (вызывается один раз на старте)
// ------------------------------------------------------------
export function bindContextMenu() {
  const menu = byId("task-context-menu");

  // Клик вне меню, прокрутка/ресайз или Escape — закрывают меню
  document.addEventListener("click", (e) => {
    if (!menu.classList.contains("hidden") && !menu.contains(e.target))
      closeContextMenu();
  });
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && !menu.classList.contains("hidden")) {
        // Не даём тому же Escape закрыть модалку под меню
        e.stopPropagation();
        closeContextMenu();
      }
    },
    true,
  );
  window.addEventListener("resize", closeContextMenu);
  window.addEventListener("scroll", closeContextMenu, true);

  // Селекты применяются сразу при изменении значения
  byId("cm-priority").addEventListener("change", async (e) => {
    const id = currentId();
    closeContextMenu();
    await actions.patchTask(id, { priority: e.target.value });
  });
  byId("cm-assignee").addEventListener("change", async (e) => {
    const id = currentId();
    closeContextMenu();
    await actions.patchTask(id, {
      assignee_id: e.target.value ? Number(e.target.value) : null,
    });
  });
  byId("cm-due").addEventListener("change", async (e) => {
    const id = currentId();
    closeContextMenu();
    await actions.patchTask(id, { due_date: e.target.value || "" });
  });
  byId("cm-column").addEventListener("change", async (e) => {
    const id = currentId();
    closeContextMenu();
    await actions.moveTaskToColumn(id, Number(e.target.value));
  });

  // «Подзадача» раскрывает инлайн-поле ввода
  document
    .querySelector('#task-context-menu [data-action="subtask"]')
    .addEventListener("click", () => {
      byId("cm-subtask-form").classList.remove("hidden");
      byId("cm-subtask-input").focus();
    });
  const subtaskHandler = async () => {
    const id = currentId();
    await actions.addSubtaskFromMenu(id);
    closeContextMenu();
  };
  byId("cm-subtask-add").addEventListener("click", subtaskHandler);
  byId("cm-subtask-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      subtaskHandler();
    }
  });

  document
    .querySelector('#task-context-menu [data-action="open"]')
    .addEventListener("click", () => {
      const id = currentId();
      closeContextMenu();
      actions.openTaskFromMenu(id);
    });
  document
    .querySelector('#task-context-menu [data-action="copy"]')
    .addEventListener("click", async () => {
      const id = currentId();
      closeContextMenu();
      await actions.copyTaskTitle(id);
    });
  document
    .querySelector('#task-context-menu [data-action="move-board"]')
    .addEventListener("click", () => {
      const id = currentId();
      closeContextMenu();
      actions.moveTaskToBoard(id);
    });
  document
    .querySelector('#task-context-menu [data-action="delete"]')
    .addEventListener("click", async () => {
      const id = currentId();
      closeContextMenu();
      await actions.deleteTaskFromMenu(id);
    });
}
