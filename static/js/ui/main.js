// ==========================================================
// Точка входа. Здесь — только загрузка приложения и привязка
// глобальных обработчиков; вся логика живёт в модулях.
//
// core/     — инфраструктура: config, api, dom, format, modal, toast
// domain/   — состояние приложения: store, state-loader
// ui/       — интерфейс:
//   boards     — выбор/создание досок
//   board      — рендер колонок и карточек, drag&drop
//   task-card  — карточка + контекстное меню (ПКМ)
//   task-modal — модалка задачи (подзадачи, файлы, комментарии)
//   state-loader — загрузка состояния доски (domain/)
//   calendar   — панель календаря
//   people     — участники и «Я:»
// ==========================================================

import { byId } from "../core/dom.js";
import { renderIcons } from "../core/icons.js";
import {
  state, boards, currentBoardId, currentUserId, onlyMine,
  setCurrentUserId, setCurrentBoardId, setSearchQuery, setOnlyMine,
} from "../domain/store.js";
import { API } from "../core/api.js";
import { showToast } from "../core/toast.js";
import { bindModalEscape, isModalOpen } from "../core/modal.js";
import { fetchBoards, renderBoardSelect, bindBoards } from "./boards.js";
import { renderBoard } from "./board.js";
import { bindContextMenu } from "./task-card.js";
import { loadState } from "../domain/state-loader.js";
import { openTaskModal, bindTaskModal } from "./task-modal.js";
import { bindCalendar } from "./calendar.js";
import { bindPeople } from "./people.js";

async function boot() {
  renderIcons();
  try {
    await fetchBoards();
  } catch (e) {
    showToast("Сервер недоступен. Запустите server.py или desktop.py.");
    return;
  }
  if (boards.length === 0) return; // shouldn't happen, backend seeds one
  // Сохранённой доски нет или она исчезла — берём первую
  if (!currentBoardId || !boards.find(b => b.id === currentBoardId)) {
    setCurrentBoardId(boards[0].id);
  }
  renderBoardSelect();
  await loadState();
  bindGlobalEvents();
}

function bindGlobalEvents() {
  // Поиск
  byId("search-input").addEventListener("input", e => {
    setSearchQuery(e.target.value);
    renderBoard();
  });

  // Фильтр «Мои задачи»
  const myTasksBtn = byId("my-tasks-btn");
  myTasksBtn.addEventListener("click", () => {
    setOnlyMine(!onlyMine);
    myTasksBtn.classList.toggle("toggle-active", onlyMine);
    renderBoard();
  });

  // Горячие клавиши: "/" — фокус поиска, N — новая задача, Alt+M — фильтр «Мои задачи»
  document.addEventListener("keydown", e => {
    const target = e.target;
    const isTyping = target && (
      target.tagName === "INPUT" || target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT" || target.isContentEditable
    );
    if (e.key === "/" && !isTyping && !isModalOpen()) {
      e.preventDefault();
      byId("search-input").focus();
    } else if ((e.key === "n" || e.key === "N" || e.key === "т" || e.key === "Т") && !isTyping && !isModalOpen()) {
      e.preventDefault();
      createAndOpenTask();
    } else if (e.altKey && (e.key === "m" || e.key === "M" || e.key === "ь" || e.key === "Ь")) {
      e.preventDefault();
      myTasksBtn.click();
    }
  });

  byId("new-task-btn").addEventListener("click", createAndOpenTask);

  bindModalEscape();
  bindContextMenu();
  bindTaskModal();
  bindCalendar();
  bindPeople();
  bindBoards();
}

// ------------------------------------------------------------
// Новая задача — создаётся в первой неDone колонке (обычно «Бэклог»)
// и сразу открывается в модалке. Исполнитель — текущий пользователь,
// иначе при включённом фильтре «Мои задачи» карточка была бы невидимой.
// ------------------------------------------------------------
export async function createAndOpenTask() {
  if (!currentUserId && state.users.length) setCurrentUserId(state.users[0].id);
  const col = state.columns.find(c => !c.is_done_state) || state.columns[0];
  if (!col) return;
  const task = await API.post("/api/tasks", {
    board_id: currentBoardId,
    column_id: col.id,
    title: "Новая задача",
    assignee_id: currentUserId,
  });
  await loadState();
  await openTaskModal(task.id, { selectTitle: true, isNew: true });
}

// Обратный вызов для tray-приложения (desktop.py)
window.TaskBoard = {
  openQuickAdd() { createAndOpenTask(); },
};
document.addEventListener("DOMContentLoaded", boot);
