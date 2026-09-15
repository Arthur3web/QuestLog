// ==========================================================
// Карточка задачи на доске + контекстное меню (ПКМ).
//
// Карточка и меню живут вместе: у них общий набор действий над
// задачей, и правый клик — это просто второй способ вызвать их.
// ==========================================================

import { API } from "../core/api.js";
import { byId, escapeHtml, initials } from "../core/dom.js";
import { formatDate, isOverdue } from "../core/format.js";
import { PRIORITY_LABEL } from "../core/config.js";
import { state, userById, findTaskById } from "../domain/store.js";
import { confirmDialog } from "../core/modal.js";
import { showToast } from "../core/toast.js";
import { loadState } from "../domain/state-loader.js";
import { openTaskModal } from "./task-modal.js";

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

  const dueHtml = task.due_date
    ? `<span class="card-due ${isOverdue(task.due_date) ? "overdue" : ""}">${formatDate(task.due_date)}</span>`
    : "";

  card.innerHTML = `
    <div class="card-title">${escapeHtml(task.title)}</div>
    ${tagsHtml}
    <div class="card-footer">
      <span class="priority-dot ${task.priority}"></span>
      <span class="priority-label">${PRIORITY_LABEL[task.priority] || task.priority}</span>
      ${dueHtml}
      <span class="spacer"></span>
      ${task.subtasks_total ? `<span class="mini-meta">☑${task.subtasks_done}/${task.subtasks_total}</span>` : ""}
      ${task.comments_count ? `<span class="mini-meta">💬${task.comments_count}</span>` : ""}
      ${task.attachments_count ? `<span class="mini-meta">📎${task.attachments_count}</span>` : ""}
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

async function patchTask(fields) {
  if (!contextMenuTaskId) return;
  await API.put(`/api/tasks/${contextMenuTaskId}`, fields);
  await loadState();
}

async function moveTaskToColumn(columnId) {
  if (!contextMenuTaskId) return;
  await API.post(`/api/tasks/${contextMenuTaskId}/move`, {
    column_id: columnId,
    position: 9999,
  });
  closeContextMenu();
  await loadState();
}

async function addSubtaskFromMenu() {
  const input = byId("cm-subtask-input");
  const title = input.value.trim();
  if (!title || !contextMenuTaskId) return;
  await API.post(`/api/tasks/${contextMenuTaskId}/subtasks`, { title });
  input.value = "";
  await loadState();
  closeContextMenu();
}

async function copyTaskTitle() {
  const task = findTaskById(contextMenuTaskId);
  if (!task) return;
  try {
    await navigator.clipboard.writeText(task.title);
    showToast("Название скопировано");
  } catch (e) {
    showToast("Не удалось скопировать");
  }
  closeContextMenu();
}

async function deleteTaskFromMenu() {
  const id = contextMenuTaskId;
  const task = findTaskById(id);
  if (!id || !task) return;
  closeContextMenu();
  const ok = await confirmDialog(
    `Удалить задачу «${task.title}» без возможности восстановления?`,
    { title: "Удалить задачу" },
  );
  if (!ok) return;
  await API.del(`/api/tasks/${id}`);
  await loadState();
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
    await patchTask({ priority: e.target.value });
    closeContextMenu();
  });
  byId("cm-assignee").addEventListener("change", async (e) => {
    await patchTask({
      assignee_id: e.target.value ? Number(e.target.value) : null,
    });
    closeContextMenu();
  });
  byId("cm-due").addEventListener("change", async (e) => {
    await patchTask({ due_date: e.target.value || "" });
    closeContextMenu();
  });
  byId("cm-column").addEventListener("change", (e) =>
    moveTaskToColumn(Number(e.target.value)),
  );

  // «Подзадача» раскрывает инлайн-поле ввода
  document
    .querySelector('#task-context-menu [data-action="subtask"]')
    .addEventListener("click", () => {
      byId("cm-subtask-form").classList.remove("hidden");
      byId("cm-subtask-input").focus();
    });
  byId("cm-subtask-add").addEventListener("click", addSubtaskFromMenu);
  byId("cm-subtask-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addSubtaskFromMenu();
    }
  });

  document
    .querySelector('#task-context-menu [data-action="open"]')
    .addEventListener("click", () => {
      const id = contextMenuTaskId;
      closeContextMenu();
      if (id) openTaskModal(id);
    });
  document
    .querySelector('#task-context-menu [data-action="copy"]')
    .addEventListener("click", copyTaskTitle);
  document
    .querySelector('#task-context-menu [data-action="delete"]')
    .addEventListener("click", deleteTaskFromMenu);
}
