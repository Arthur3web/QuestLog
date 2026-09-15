// ==========================================================
// Выбор и создание досок.
// ==========================================================

import { API } from "../core/api.js";
import { byId } from "../core/dom.js";
import {
  boards, currentBoardId,
  setBoards, pushBoard, setCurrentBoardId,
} from "../domain/store.js";
import { showModal, hideModal } from "../core/modal.js";
import { loadState } from "../domain/state-loader.js";

export function renderBoardSelect() {
  const sel = byId("board-select");
  sel.innerHTML = "";
  boards.forEach(b => {
    const opt = document.createElement("option");
    opt.value = b.id;
    opt.textContent = b.name;
    if (b.id === currentBoardId) opt.selected = true;
    sel.appendChild(opt);
  });
  sel.onchange = async () => {
    setCurrentBoardId(Number(sel.value));
    await loadState();
  };
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
  renderBoardSelect();
  await loadState();
}

export function bindBoards() {
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
