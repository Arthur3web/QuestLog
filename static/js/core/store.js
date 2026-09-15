// ==========================================================
// Единая точка хранения состояния приложения.
//
// Все модули читают состояние через state (живой объект) и
// меняют его через сеттеры ниже. Никакие другие модули не
// присваивают state = ... — это позволяет видеть в одном
// файле, что вообще может поменяться.
// ==========================================================

import { LS_KEYS } from "./config.js";

export let state = { board_id: null, columns: [], users: [] };
export let boards = [];

function readNumber(key) {
  const raw = localStorage.getItem(key);
  return raw ? Number(raw) : null;
}

export let currentBoardId = readNumber(LS_KEYS.boardId);
export let currentUserId = readNumber(LS_KEYS.currentUser);

export let openTaskId = null;
export let openTaskSnapshot = null; // поля задачи на момент открытия/сохранения
export let searchQuery = "";
export let onlyMine = false;
export let columnComposeOpen = false; // открыта ли инлайн-форма добавления колонки

// --- сеттеры: единственный способ изменить состояние ---

export function setState(next) {
  state = next;
}
export function setBoards(next) {
  boards = next;
}
export function pushBoard(board) {
  boards.push(board);
}

export function setCurrentBoardId(id) {
  currentBoardId = id;
  localStorage.setItem(LS_KEYS.boardId, id);
}

export function setCurrentUserId(id) {
  currentUserId = id;
  localStorage.setItem(LS_KEYS.currentUser, id);
}

export function setOpenTask(taskId, snapshot) {
  openTaskId = taskId;
  openTaskSnapshot = snapshot;
}
export function clearOpenTask() {
  openTaskId = null;
  openTaskSnapshot = null;
}

export function setSearchQuery(q) {
  searchQuery = q;
}
export function setOnlyMine(v) {
  onlyMine = v;
}
export function setColumnComposeOpen(v) {
  columnComposeOpen = v;
}

// Поиск задачи по id среди уже загруженных колонок
export function findTaskById(taskId) {
  for (const col of state.columns) {
    const task = col.tasks.find((t) => t.id === taskId);
    if (task) return task;
  }
  return null;
}

export function userById(id) {
  return state.users.find((u) => u.id === id);
}
