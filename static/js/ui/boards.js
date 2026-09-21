// ==========================================================
// Доски: выбор, создание и переименование.
//
// Переключение и переименование — разные действия, поэтому у них
// разные элементы в шапке: клик по названию переименовывает, клик
// по стрелке открывает меню выбора доски.
// ==========================================================

import { API } from "../core/api.js";
import { byId } from "../core/dom.js";
import {
  boards, currentBoardId,
  setBoards, pushBoard, setCurrentBoardId,
} from "../domain/store.js";
import { showModal, hideModal } from "../core/modal.js";
import { showToast } from "../core/toast.js";
import { loadState, onStateLoaded } from "../domain/state-loader.js";

let boardMenuOpen = false;

export function currentBoard() {
  return boards.find(b => b.id === currentBoardId) || null;
}

// ------------------------------------------------------------
// Название доски (переименование инлайн)
// ------------------------------------------------------------
export function renderBoardTitle() {
  const el = byId("board-title");
  if (!el) return;
  const board = currentBoard();
  // Не трогаем текст, пока его редактируют, иначе улетает каретка.
  if (document.activeElement !== el) el.textContent = board ? board.name : "";
}

async function commitBoardRename() {
  const el = byId("board-title");
  const board = currentBoard();
  if (!el || !board) return;

  const name = el.textContent.replace(/\s+/g, " ").trim();
  if (!name) {
    el.textContent = board.name; // пустое имя — возвращаем прежнее
    return;
  }
  if (name === board.name) {
    el.textContent = board.name;
    return;
  }

  try {
    const updated = await API.put(`/api/boards/${board.id}`, { name });
    board.name = updated.name;
    el.textContent = updated.name;
    renderBoardMenu();
    showToast("Доска переименована");
  } catch (e) {
    el.textContent = board.name;
    showToast("Не удалось переименовать доску");
  }
}

// ------------------------------------------------------------
// Меню выбора доски
// ------------------------------------------------------------
export function renderBoardMenu() {
  const menu = byId("board-menu");
  if (!menu) return;
  menu.innerHTML = "";
  boards.forEach(b => {
    const li = document.createElement("li");
    li.className = "board-menu-item" + (b.id === currentBoardId ? " active" : "");
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", String(b.id === currentBoardId));
    li.dataset.boardId = b.id;
    li.textContent = b.name;
    menu.appendChild(li);
  });
}

function openBoardMenu() {
  boardMenuOpen = true;
  renderBoardMenu();
  const menu = byId("board-menu");
  const btn = byId("board-switch-btn");

  // Меню — position: fixed, поэтому координаты считаем от кнопки сами.
  // Сначала показываем, чтобы измерить реальный размер.
  menu.classList.remove("hidden");
  btn.setAttribute("aria-expanded", "true");

  const r = btn.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;

  // не даём меню вылезти за правый край и за нижнюю границу экрана
  let left = r.left;
  if (left + mw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - mw - 8);
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);

  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}

export function closeBoardMenu() {
  boardMenuOpen = false;
  const menu = byId("board-menu");
  if (menu) menu.classList.add("hidden");
  const btn = byId("board-switch-btn");
  if (btn) btn.setAttribute("aria-expanded", "false");
}

async function switchBoard(boardId) {
  closeBoardMenu();
  if (boardId === currentBoardId) return;
  setCurrentBoardId(boardId);
  renderBoardTitle();
  await loadState();
}

// Кнопка «Создать» неактивна, пока название доски не введено
export function updateCreateBoardButtonState() {
  const btn = byId("create-board-btn");
  const input = byId("new-board-name");
  if (btn && input) btn.disabled = input.value.trim().length === 0;
}

function openBoardModal() {
  const input = byId("new-board-name");
  input.value = "";
  updateCreateBoardButtonState();
  showModal("board-modal");
  setTimeout(() => input.focus(), 30);
}

async function createBoardFromModal() {
  const input = byId("new-board-name");
  const name = input.value.trim();
  if (!name) return;
  const board = await API.post("/api/boards", { name });
  pushBoard(board);
  setCurrentBoardId(board.id);
  input.value = "";
  hideModal("board-modal");
  renderBoardTitle();
  renderBoardMenu();
  await loadState();
}

// ------------------------------------------------------------
// Привязка событий (один раз на старте)
// ------------------------------------------------------------
export function bindBoards() {
  // Название доски обновляем после каждой загрузки состояния
  // (переключение доски, перенос задач и т.п.).
  onStateLoaded(renderBoardTitle);

  const title = byId("board-title");

  title.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); title.blur(); }
    if (e.key === "Escape") {
      e.preventDefault();
      const board = currentBoard();
      if (board) title.textContent = board.name;
      title.blur();
    }
  });
  title.addEventListener("blur", commitBoardRename);

  // Клик по кнопке-стрелке переключает меню: один обработчик и
  // открывает, и закрывает, поэтому повторный клик закрывает его всегда.
  byId("board-switch-btn").addEventListener("click", e => {
    e.stopPropagation();
    if (boardMenuOpen) closeBoardMenu();
    else openBoardMenu();
  });

  // Клик по пункту меню переключает доску.
  byId("board-menu").addEventListener("click", e => {
    const item = e.target.closest(".board-menu-item");
    if (item) switchBoard(Number(item.dataset.boardId));
  });

  // Клик вне меню закрывает его.
  document.addEventListener("click", e => {
    if (!boardMenuOpen) return;
    if (e.target.closest("#board-menu") || e.target.closest("#board-switch-btn")) return;
    closeBoardMenu();
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && boardMenuOpen) closeBoardMenu();
  });
  window.addEventListener("resize", closeBoardMenu);
  // Меню закреплено на экране (position: fixed) — при прокрутке оно бы
  // осталось на месте и потеряло связь с кнопкой, поэтому закрываем.
  window.addEventListener("scroll", closeBoardMenu, true);

  byId("new-board-btn").addEventListener("click", openBoardModal);
  byId("create-board-btn").addEventListener("click", createBoardFromModal);
  byId("new-board-name").addEventListener("input", updateCreateBoardButtonState);
  byId("new-board-name").addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); createBoardFromModal(); }
  });
  updateCreateBoardButtonState();
}

// Загрузка списка досок с сервера (вызывается один раз при старте)
export async function fetchBoards() {
  setBoards(await API.get("/api/boards"));
  return boards;
}
