// ==========================================================
// Действия контекстного меню (ПКМ по карточке задачи).
//
// Вынесено из task-card.js отдельным модулем: карточка — это то,
// что видно на доске, а действия — то, что меняет данные. Раньше
// они жили в одном файле, и опечатка в действии («Перенести на
// доску») роняла весь граф модулей — доска не открывалась вовсе.
//
// Модуль читает id задачи через инъекцию: menu.js владеет
// состоянием «какая задача сейчас в меню» и передаёт его сюда.
// Так нет импорта из task-card.js и нет циклической зависимости.
// ==========================================================

import { API } from "../core/api.js";
import { byId } from "../core/dom.js";
import { confirmDialog } from "../core/modal.js";
import { showToast } from "../core/toast.js";
import { findTaskById } from "../domain/store.js";
import { loadState } from "../domain/state-loader.js";
import { openTaskModal } from "./task-modal.js";
import { openBulkMoveForTask } from "./bulk-move.js";

// Прямое сохранение полей задачи без открытия модалки
export async function patchTask(taskId, fields) {
  if (!taskId) return;
  await API.put(`/api/tasks/${taskId}`, fields);
  await loadState();
}

export async function moveTaskToColumn(taskId, columnId) {
  if (!taskId) return;
  await API.post(`/api/tasks/${taskId}/move`, {
    column_id: columnId,
    position: 9999,
  });
  await loadState();
}

export async function addSubtaskFromMenu(taskId) {
  const input = byId("cm-subtask-input");
  const title = input.value.trim();
  if (!title || !taskId) return;
  await API.post(`/api/tasks/${taskId}/subtasks`, { title });
  input.value = "";
  await loadState();
}

export async function copyTaskTitle(taskId) {
  const task = findTaskById(taskId);
  if (!task) return;
  try {
    await navigator.clipboard.writeText(task.title);
    showToast("Название скопировано");
  } catch (e) {
    showToast("Не удалось скопировать");
  }
}

export function moveTaskToBoard(taskId) {
  if (!taskId) return;
  openBulkMoveForTask(taskId);
}

export async function deleteTaskFromMenu(taskId) {
  const task = findTaskById(taskId);
  if (!taskId || !task) return;
  const ok = await confirmDialog(
    `Удалить задачу «${task.title}» без возможности восстановления?`,
    { title: "Удалить задачу" },
  );
  if (!ok) return;
  await API.del(`/api/tasks/${taskId}`);
  await loadState();
}

export function openTaskFromMenu(taskId) {
  if (taskId) openTaskModal(taskId);
}
