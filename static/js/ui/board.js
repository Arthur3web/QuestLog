// ==========================================================
// Рендер доски: колонки, карточки, drag&drop, поиск и фильтр
// «Мои задачи».
// ==========================================================

import { API } from "../core/api.js";
import { byId, escapeHtml } from "../core/dom.js";
import { ICONS } from "../core/icons.js";
import {
  state, currentBoardId, searchQuery, onlyMine,
  columnComposeOpen, setColumnComposeOpen, currentUserId,
} from "../domain/store.js";
import { confirmDialog } from "../core/modal.js";
import { showToast } from "../core/toast.js";
import { renderCard } from "./task-card.js";
import { loadState } from "../domain/state-loader.js";

export function renderBoard() {
  const board = byId("board");
  const scrollLeft = board.scrollLeft;
  board.innerHTML = "";
  state.columns.forEach(col => board.appendChild(renderColumn(col)));
  board.appendChild(renderAddColumn());
  board.scrollLeft = scrollLeft;

  // Фильтр «Мои задачи» прячет задачи без исполнителя — показываем сколько,
  // иначе кажется, что новые задачи «не сохраняются» и пропадают при переключении досок.
  const myBtn = byId("my-tasks-btn");
  if (myBtn) {
    const hidden = onlyMine
      ? state.columns.reduce((n, c) => n + c.tasks.filter(t => t.assignee_id !== currentUserId).length, 0)
      : 0;
    myBtn.textContent = (onlyMine && hidden > 0) ? `Мои задачи · скрыто ${hidden}` : "Мои задачи";
  }
}

function taskMatchesSearch(t) {
  if (!searchQuery) return true;
  const q = searchQuery.toLowerCase();
  return t.title.toLowerCase().includes(q) ||
    (t.description || "").toLowerCase().includes(q) ||
    t.tags.some(tag => tag.toLowerCase().includes(q));
}

function renderColumn(col) {
  const wrap = document.createElement("div");
  wrap.className = "column";

  const header = document.createElement("div");
  header.className = "column-header";
  header.innerHTML = `
    <div class="column-title-group">
      <span class="column-title" contenteditable="true" spellcheck="false">${escapeHtml(col.name)}</span>
      <span class="column-count">${col.tasks.length}</span>
    </div>
    <div class="column-actions">
      <button class="delete-col-btn" title="Удалить колонку">${ICONS.close}</button>
    </div>
  `;
  const titleEl = header.querySelector(".column-title");
  titleEl.addEventListener("blur", async () => {
    const newName = titleEl.textContent.trim();
    if (newName && newName !== col.name) {
      await API.put(`/api/columns/${col.id}`, { name: newName });
      await loadState();
    } else {
      titleEl.textContent = col.name;
    }
  });
  titleEl.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); titleEl.blur(); }
  });
  header.querySelector(".delete-col-btn").addEventListener("click", async () => {
    const ok = await confirmDialog(
      `Удалить колонку «${col.name}»?`,
      { title: "Удалить колонку" }
    );
    if (!ok) return;
    const res = await API.del(`/api/columns/${col.id}`);
    if (res.error) { showToast(res.error); return; }
    await loadState();
  });
  wrap.appendChild(header);

  const list = document.createElement("div");
  list.className = "task-list";
  list.dataset.columnId = col.id;
  col.tasks.filter(taskMatchesSearch).forEach(t => list.appendChild(renderCard(t)));
  attachDropZone(list);
  wrap.appendChild(list);

  return wrap;
}

function renderAddColumn() {
  const wrap = document.createElement("div");
  wrap.className = "column new-column";

  if (!columnComposeOpen) {
    const btn = document.createElement("button");
    btn.className = "add-task-btn";
    btn.style.marginTop = "4px";
    btn.textContent = "+ добавить колонку";
    btn.addEventListener("click", () => {
      setColumnComposeOpen(true);
      renderBoard();
      focusColumnCompose();
    });
    wrap.appendChild(btn);
    return wrap;
  }

  const compose = document.createElement("div");
  compose.className = "inline-compose";
  compose.innerHTML = `
    <input type="text" placeholder="Название колонки">
    <div class="inline-compose-actions">
      <span>Enter — добавить</span><span>Esc — отмена</span>
    </div>
  `;
  const input = compose.querySelector("input");
  const finish = () => { setColumnComposeOpen(false); renderBoard(); };
  const submit = async () => {
    const name = input.value.trim();
    if (!name) { finish(); return; }
    await API.post("/api/columns", { board_id: currentBoardId, name });
    await loadState();
    setColumnComposeOpen(false);
    renderBoard();
  };
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); submit(); }
    if (e.key === "Escape") { e.preventDefault(); finish(); }
  });
  input.addEventListener("blur", () => {
    // Даём клику по подсказке отработать до закрытия формы
    setTimeout(() => { if (columnComposeOpen) finish(); }, 120);
  });
  wrap.appendChild(compose);
  return wrap;
}

function focusColumnCompose() {
  setTimeout(() => {
    const input = document.querySelector(".new-column .inline-compose input");
    if (input) input.focus();
  }, 30);
}

// ------------------------------------------------------------
// Drag & drop между / внутри колонок
// ------------------------------------------------------------
function attachDropZone(list) {
  list.addEventListener("dragover", e => {
    e.preventDefault();
    list.classList.add("drag-over");
    const dragging = document.querySelector(".card.dragging");
    if (!dragging) return;
    const after = getDragAfterElement(list, e.clientY);
    if (after == null) list.appendChild(dragging);
    else list.insertBefore(dragging, after);
  });
  list.addEventListener("dragleave", () => list.classList.remove("drag-over"));
  list.addEventListener("drop", async e => {
    e.preventDefault();
    list.classList.remove("drag-over");
    const taskId = Number(e.dataTransfer.getData("text/plain"));
    const columnId = Number(list.dataset.columnId);
    const cards = [...list.querySelectorAll(".card")];
    const position = cards.findIndex(c => Number(c.dataset.taskId) === taskId);
    await API.post(`/api/tasks/${taskId}/move`, { column_id: columnId, position });
    await loadState();
  });
}

function getDragAfterElement(container, y) {
  const els = [...container.querySelectorAll(".card:not(.dragging)")];
  return els.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) return { offset, element: child };
    return closest;
  }, { offset: Number.NEGATIVE_INFINITY, element: null }).element;
}
