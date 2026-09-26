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
import { fetchBoards, renderBoardTitle, bindBoards } from "./boards.js";
import { renderBoard } from "./board.js";
import { bindContextMenu } from "./task-card.js";
import { loadState } from "../domain/state-loader.js";
import { openTaskModal, bindTaskModal, openNewTaskModal } from "./task-modal.js";
import { bindCalendar } from "./calendar.js";
import { bindPeople } from "./people.js";
import { bindBulkMove } from "./bulk-move.js";
import { attachDatePicker, bindDatePickers } from "./date-picker.js";
import { applyTheme, bindTheme, currentTheme } from "./theme.js";

async function boot() {
  renderIcons();
  // Тему применяет ещё inline-скрипт в index.html (чтобы не мигало), но
  // здесь повторяем: если в localStorage лежало устаревшее значение темы,
  // атрибут нормализуется к доступной теме.
  applyTheme(currentTheme());
  try {
    await fetchBoards();
  } catch (e) {
    showToast("Сервер недоступен. Запустите server.py или desktop.py.");
    return;
  }
  if (boards.length === 0) {
    // Сервер засеивает доску при первом запуске, поэтому пустой список
    // означает проблему в БД — сообщаем, а не оставляем пустой экран.
    showToast("Досок нет: возможно, база данных повреждена. Подробности — в консоли (F12).");
    console.error("[QuestLog] Список досок пуст после загрузки с сервера.");
    return;
  }
  // Сохранённой доски нет или она исчезла — берём первую
  if (!currentBoardId || !boards.find(b => b.id === currentBoardId)) {
    setCurrentBoardId(boards[0].id);
  }
  renderBoardTitle();
  await loadState();
  bindGlobalEvents();
}

// ------------------------------------------------------------
// Запуск приложения с явным отчётом об ошибке.
//
// boot() — async, а обработчик DOMContentLoaded не умеет ловить
// reject: без .catch() любая ошибка (даже SyntaxError в одном
// из модулей графа) тихо превращает страницу в пустую доску без
// единой строчки в консоли. Поэтому логируем её сами.
// ------------------------------------------------------------
function startApp() {
  boot().catch(e => {
    console.error("[QuestLog] Не удалось запустить приложение:", e);
    showToast("Не удалось загрузить доску. Подробности — в консоли (F12).");
  });
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
  bindBulkMove();
  bindTheme();

  // Тематический выбор даты вместо нативного календаря браузера.
  bindDatePickers();
  attachDatePicker(byId("tm-due"));
  attachDatePicker(byId("cm-due"));
}

// ------------------------------------------------------------
// Новая задача — открывает форму создания. Запись в БД создаётся
// одним POST-запросом по кнопке «Создать» (см. task-modal.js),
// поэтому случайный клик больше не оставляет пустых «Новых задач»
// на доске. Исполнитель по умолчанию — текущий пользователь, иначе
// при включённом фильтре «Мои задачи» карточка была бы невидимой.
// ------------------------------------------------------------
export async function createAndOpenTask() {
  if (!currentUserId && state.users.length) setCurrentUserId(state.users[0].id);
  await openNewTaskModal();
}

// Обратный вызов для tray-приложения (desktop.py)
window.TaskBoard = {
  openQuickAdd() { createAndOpenTask(); },
};
document.addEventListener("DOMContentLoaded", startApp);
