// ==========================================================
// TaskBoard frontend — no build step, no external libraries.
// ==========================================================
const API = {
  async get(url) { return (await fetch(url)).json(); },
  async post(url, body) {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    return res.json();
  },
  async put(url, body) {
    const res = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    return res.json();
  },
  async del(url) {
    const res = await fetch(url, { method: "DELETE" });
    return res.json();
  },
};

const PRIORITY_LABEL = { high: "Высокий", medium: "Средний", normal: "Обычный", low: "Низкий" };

// Готовый набор тегов для быстрого клика — типичные категории личных задач
const TAG_PRESETS = ["Срочно", "Работа", "Личное", "Идея", "Баг", "Покупки"];

let state = { board_id: null, columns: [], users: [] };
let boards = [];
let currentBoardId = localStorage.getItem("tb_board_id") ? Number(localStorage.getItem("tb_board_id")) : null;
let currentUserId = localStorage.getItem("tb_current_user") ? Number(localStorage.getItem("tb_current_user")) : null;
let openTaskId = null;
let openTaskSnapshot = null;  // значения полей задачи на момент открытия/последнего сохранения
let searchQuery = "";
let onlyMine = false;
let columnComposeOpen = false;        // открыта ли инлайн-форма добавления колонки


// ------------------------------------------------------------
// Bootstrap
// ------------------------------------------------------------
async function boot() {
  try {
    boards = await API.get("/api/boards");
  } catch (e) {
    showToast("Сервер недоступен. Запустите server.py или desktop.py.");
    return;
  }
  if (boards.length === 0) return; // shouldn't happen, backend seeds one
  if (!currentBoardId || !boards.find(b => b.id === currentBoardId)) {
    currentBoardId = boards[0].id;
  }
  renderBoardSelect();
  await loadState();
  bindGlobalEvents();
}

async function loadState() {
  state = await API.get(`/api/state?board_id=${currentBoardId}`);
  if (!currentUserId && state.users.length) {
    currentUserId = state.users[0].id;
    localStorage.setItem("tb_current_user", currentUserId);
  }
  renderIdentitySelect();
  renderBoard();
}

// ------------------------------------------------------------
// Modal stack — ESC / overlay / ✕ always close the topmost modal
// ------------------------------------------------------------
const modalStack = [];
const onCloseCallbacks = new Map(); // overlay id -> callback

function openOverlay(id, onClose) {
  const ov = document.getElementById(id);
  if (!ov) return null;
  if (modalStack.includes(ov)) return ov;
  ov.classList.remove("hidden");
  modalStack.push(ov);
  if (onClose) onCloseCallbacks.set(id, onClose);
  return ov;
}

function closeOverlay(ov) {
  if (!ov) return;
  const idx = modalStack.lastIndexOf(ov);
  if (idx !== -1) modalStack.splice(idx, 1);
  ov.classList.add("hidden");
  const cb = onCloseCallbacks.get(ov.id);
  if (cb) { onCloseCallbacks.delete(ov.id); cb(); }
}

function closeTopModal() {
  closeOverlay(modalStack[modalStack.length - 1]);
}

function showModal(id, onClose) { openOverlay(id, onClose); }
function hideModal(id) { closeOverlay(document.getElementById(id)); }

// ------------------------------------------------------------
// Promise-based confirm dialog (no native window.confirm)
// ------------------------------------------------------------
function confirmDialog(message, { title = "Подтверждение", okLabel = "Удалить", danger = true } = {}) {
  return new Promise(resolve => {
    document.getElementById("confirm-title").textContent = title;
    document.getElementById("confirm-text").textContent = message;
    const ok = document.getElementById("confirm-ok");
    ok.textContent = okLabel;
    ok.className = danger ? "btn-danger" : "btn-primary";

    let done = false;
    const finish = value => {
      if (done) return;
      done = true;
      document.getElementById("confirm-ok").onclick = null;
      document.getElementById("confirm-cancel").onclick = null;
      closeOverlay(document.getElementById("confirm-modal"));
      resolve(value);
    };
    document.getElementById("confirm-ok").onclick = () => finish(true);
    document.getElementById("confirm-cancel").onclick = () => finish(false);

    openOverlay("confirm-modal", () => finish(false));
    setTimeout(() => ok.focus(), 30);
  });
}

// ------------------------------------------------------------
// Board select / creation
// ------------------------------------------------------------
function renderBoardSelect() {
  const sel = document.getElementById("board-select");
  sel.innerHTML = "";
  boards.forEach(b => {
    const opt = document.createElement("option");
    opt.value = b.id;
    opt.textContent = b.name;
    if (b.id === currentBoardId) opt.selected = true;
    sel.appendChild(opt);
  });
  sel.onchange = async () => {
    currentBoardId = Number(sel.value);
    localStorage.setItem("tb_board_id", currentBoardId);
    await loadState();
  };
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("new-board-btn").onclick = () => {
    const input = document.getElementById("new-board-name");
    input.value = "";
    showModal("board-modal");
    setTimeout(() => input.focus(), 30);
  };
  document.getElementById("create-board-btn").onclick = createBoardFromModal;
  document.getElementById("new-board-name").addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); createBoardFromModal(); }
  });
  boot();
});

async function createBoardFromModal() {
  const name = document.getElementById("new-board-name").value.trim();
  if (!name) return;
  const board = await API.post("/api/boards", { name });
  boards.push(board);
  currentBoardId = board.id;
  localStorage.setItem("tb_board_id", currentBoardId);
  document.getElementById("new-board-name").value = "";
  hideModal("board-modal");
  renderBoardSelect();
  await loadState();
}

// ------------------------------------------------------------
// Identity ("Я:") + participants management
// ------------------------------------------------------------
function initials(name) {
  return name.trim().slice(0, 2).toUpperCase();
}

function renderIdentitySelect() {
  const sel = document.getElementById("current-user-select");
  sel.innerHTML = state.users.map(u => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join("");
  sel.value = currentUserId || (state.users[0] && state.users[0].id) || "";
}

document.getElementById("manage-people-btn").addEventListener("click", () => {
  renderPeopleList();
  const input = document.getElementById("new-person-name");
  input.value = "";
  showModal("people-modal");
  setTimeout(() => input.focus(), 30);
});

function renderPeopleList() {
  const list = document.getElementById("people-list");
  list.innerHTML = "";
  state.users.forEach(u => {
    const row = document.createElement("div");
    row.className = "person-row";
    row.innerHTML = `
      <div class="avatar" style="background:${u.color}">${initials(u.name)}</div>
      <span class="name">${escapeHtml(u.name)}</span>
      <button class="remove-btn" title="Удалить">&times;</button>
    `;
    row.querySelector(".remove-btn").onclick = async () => {
      const ok = await confirmDialog(
        `Удалить участника «${u.name}»? Он будет снят со всех задач.`,
        { title: "Удалить участника" }
      );
      if (!ok) return;
      await API.del(`/api/users/${u.id}`);
      await loadState();
      renderPeopleList();
    };
    list.appendChild(row);
  });
}

document.getElementById("add-person-btn").addEventListener("click", addPersonFromModal);
document.getElementById("new-person-name").addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); addPersonFromModal(); }
});

async function addPersonFromModal() {
  const input = document.getElementById("new-person-name");
  const name = input.value.trim();
  if (!name) return;
  await API.post("/api/users", { name });
  input.value = "";
  await loadState();
  renderPeopleList();
  input.focus();
}

// ------------------------------------------------------------
// Board rendering
// ------------------------------------------------------------
function renderBoard() {
  const board = document.getElementById("board");
  const scrollLeft = board.scrollLeft;
  board.innerHTML = "";
  state.columns.forEach(col => board.appendChild(renderColumn(col)));
  board.appendChild(renderAddColumn());
  board.scrollLeft = scrollLeft;
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
      columnComposeOpen = true;
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
  const finish = () => { columnComposeOpen = false; renderBoard(); };
  const submit = async () => {
    const name = input.value.trim();
    if (!name) { finish(); return; }
    await API.post("/api/columns", { board_id: currentBoardId, name });
    columnComposeOpen = true; // остаётся открытой для быстрого добавления нескольких колонок
    await loadState();
    focusColumnCompose();
  };
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); submit(); }
    else if (e.key === "Escape") { e.preventDefault(); finish(); }
  });
  wrap.appendChild(compose);
  return wrap;
}

function focusColumnCompose() {
  setTimeout(() => {
    const el = document.querySelector(".column.new-column .inline-compose input");
    if (el) el.focus();
  }, 20);
}

function taskMatchesSearch(task) {
  if (onlyMine && task.assignee_id !== currentUserId) return false;
  if (!searchQuery) return true;
  const q = searchQuery.toLowerCase();
  return task.title.toLowerCase().includes(q) ||
    (task.description || "").toLowerCase().includes(q) ||
    task.tags.some(t => t.toLowerCase().includes(q));
}

function renderColumn(col) {
  const wrap = document.createElement("div");
  wrap.className = "column";
  wrap.dataset.columnId = col.id;

  const header = document.createElement("div");
  header.className = "column-header";
  header.innerHTML = `
    <div class="column-title-group">
      <span class="column-title" contenteditable="true" spellcheck="false">${escapeHtml(col.name)}</span>
      <span class="column-count">${col.tasks.length}</span>
    </div>
    <div class="column-actions">
      <button class="delete-col-btn" title="Удалить колонку">&times;</button>
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

function userById(id) { return state.users.find(u => u.id === id); }

function renderCard(task) {
  const card = document.createElement("div");
  card.className = "card";
  card.draggable = true;
  card.dataset.taskId = task.id;

  const tagsHtml = task.tags.length
    ? `<div class="card-tags">${task.tags.map(t => `<span class="tag-chip">${escapeHtml(t)}</span>`).join("")}</div>`
    : "";

  const assignee = userById(task.assignee_id);
  const assigneeHtml = assignee
    ? `<div class="avatar" style="width:18px;height:18px;font-size:9px;background:${assignee.color}" title="${escapeHtml(assignee.name)}">${initials(assignee.name)}</div>`
    : "";

  let dueHtml = "";
  if (task.due_date) {
    const overdue = new Date(task.due_date) < new Date(new Date().toDateString());
    dueHtml = `<span class="card-due ${overdue ? "overdue" : ""}">${formatDate(task.due_date)}</span>`;
  }

  card.innerHTML = `
    <div class="card-title">${escapeHtml(task.title)}</div>
    ${tagsHtml}
    <div class="card-footer">
      <span class="priority-dot ${task.priority}"></span>
      ${dueHtml}
      <span class="spacer"></span>
      ${task.subtasks_total ? `<span class="mini-meta">☑${task.subtasks_done}/${task.subtasks_total}</span>` : ""}
      ${task.comments_count ? `<span class="mini-meta">💬${task.comments_count}</span>` : ""}
      ${task.attachments_count ? `<span class="mini-meta">📎${task.attachments_count}</span>` : ""}
      ${assigneeHtml}
    </div>
  `;

  card.addEventListener("click", () => openTaskModal(task.id));
  card.addEventListener("dragstart", e => {
    card.classList.add("dragging");
    e.dataTransfer.setData("text/plain", String(task.id));
  });
  card.addEventListener("dragend", () => card.classList.remove("dragging"));

  return card;
}

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
}

// ------------------------------------------------------------
// Drag & drop between / within columns
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

// ------------------------------------------------------------
// New task — creates a draft in the first non-done column (Бэклог by
// default) and immediately opens the full task modal for editing; the
// «Статус» field inside the modal lets you move it to a different column.
// ------------------------------------------------------------
async function createAndOpenTask() {
  const col = state.columns.find(c => !c.is_done_state) || state.columns[0];
  if (!col) return;
  const task = await API.post("/api/tasks", { board_id: currentBoardId, column_id: col.id, title: "Новая задача" });
  await loadState();
  await openTaskModal(task.id, { selectTitle: true });
}

// Tray "Новая задача" → открывает окно и сразу карточку новой задачи
window.TaskBoard = {
  openQuickAdd() { createAndOpenTask(); },
};

// ------------------------------------------------------------
// Task modal
// ------------------------------------------------------------
async function openTaskModal(taskId, { selectTitle = false } = {}) {
  openTaskId = taskId;
  const task = await API.get(`/api/tasks/${taskId}`);

  const titleInput = document.getElementById("tm-title");
  titleInput.value = task.title;
  document.getElementById("tm-priority").value = task.priority;
  document.getElementById("tm-due").value = task.due_date || "";
  document.getElementById("tm-tags").value = task.tags.join(", ");
  document.getElementById("tm-description").value = task.description || "";
  renderTagPresets(task.tags);

  const columnSel = document.getElementById("tm-column");
  columnSel.innerHTML = state.columns.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
  columnSel.value = task.column_id;

  const assigneeSel = document.getElementById("tm-assignee");
  assigneeSel.innerHTML = `<option value="">Без исполнителя</option>` +
    state.users.map(u => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join("");
  assigneeSel.value = task.assignee_id || "";

  openTaskSnapshot = {
    title: task.title,
    description: task.description || "",
    priority: task.priority,
    assignee_id: task.assignee_id || "",
    due_date: task.due_date || "",
    tags: task.tags.join(", "),
    column_id: String(task.column_id),
  };
  updateSaveButtonState();

  const authorSel = document.getElementById("tm-comment-author");
  authorSel.innerHTML = state.users.map(u => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join("");
  authorSel.value = currentUserId || (state.users[0] && state.users[0].id) || "";

  renderSubtasks(task.subtasks);
  renderAttachments(task.attachments);
  renderComments(task.comments);

  const ov = openOverlay("task-modal", () => { openTaskId = null; openTaskSnapshot = null; });
  if (ov && !ov.dataset.boundTitle) {
    // Заголовок модалки повторяет название задачи
    document.getElementById("tm-title").addEventListener("input", e => {
      document.getElementById("tm-heading").textContent = e.target.value.trim() || "Задача";
    });
    ov.dataset.boundTitle = "1";
  }
  document.getElementById("tm-heading").textContent = task.title || "Задача";

  if (selectTitle) {
    setTimeout(() => { titleInput.focus(); titleInput.select(); }, 40);
  }
}

function currentTaskFormValues() {
  return {
    title: document.getElementById("tm-title").value,
    description: document.getElementById("tm-description").value,
    priority: document.getElementById("tm-priority").value,
    assignee_id: document.getElementById("tm-assignee").value,
    due_date: document.getElementById("tm-due").value,
    tags: document.getElementById("tm-tags").value.split(",").map(s => s.trim()).filter(Boolean).join(", "),
    column_id: document.getElementById("tm-column").value,
  };
}

function isTaskFormDirty() {
  if (!openTaskSnapshot) return false;
  const cur = currentTaskFormValues();
  return Object.keys(openTaskSnapshot).some(key => cur[key] !== openTaskSnapshot[key]);
}

function updateSaveButtonState() {
  const btn = document.getElementById("tm-save-btn");
  if (btn) btn.disabled = !isTaskFormDirty();
}

function renderSubtasks(subtasks) {
  const list = document.getElementById("tm-subtasks");
  const progress = document.getElementById("tm-subtasks-progress");
  list.innerHTML = "";
  const done = subtasks.filter(s => s.done).length;
  progress.textContent = subtasks.length ? `${done}/${subtasks.length}` : "";
  if (!subtasks.length) {
    list.innerHTML = `<span class="hint-text">Подзадач пока нет.</span>`;
    return;
  }
  subtasks.forEach(s => {
    const row = document.createElement("div");
    row.className = "subtask-item" + (s.done ? " done" : "");
    row.innerHTML = `
      <input type="checkbox" ${s.done ? "checked" : ""}>
      <input type="text" class="subtask-title" value="${escapeHtml(s.title)}">
      <button class="remove-btn" title="Удалить">&times;</button>
    `;
    const checkbox = row.querySelector('input[type="checkbox"]');
    const titleInput = row.querySelector(".subtask-title");
    checkbox.addEventListener("change", async () => {
      await API.put(`/api/subtasks/${s.id}`, { done: checkbox.checked });
      const task = await API.get(`/api/tasks/${openTaskId}`);
      renderSubtasks(task.subtasks);
      await loadState();
    });
    titleInput.addEventListener("blur", async () => {
      const value = titleInput.value.trim();
      if (!value) { titleInput.value = s.title; return; }
      if (value === s.title) return;
      await API.put(`/api/subtasks/${s.id}`, { title: value });
      const task = await API.get(`/api/tasks/${openTaskId}`);
      renderSubtasks(task.subtasks);
    });
    titleInput.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); titleInput.blur(); }
    });
    row.querySelector(".remove-btn").addEventListener("click", async () => {
      await API.del(`/api/subtasks/${s.id}`);
      const task = await API.get(`/api/tasks/${openTaskId}`);
      renderSubtasks(task.subtasks);
      await loadState();
    });
    list.appendChild(row);
  });
}

async function addSubtaskFromModal() {
  const input = document.getElementById("tm-subtask-input");
  const title = input.value.trim();
  if (!title || !openTaskId) return;
  await API.post(`/api/tasks/${openTaskId}/subtasks`, { title });
  input.value = "";
  const task = await API.get(`/api/tasks/${openTaskId}`);
  renderSubtasks(task.subtasks);
  await loadState();
  input.focus();
}

function renderAttachments(attachments) {
  const list = document.getElementById("tm-attachments");
  list.innerHTML = "";
  if (!attachments.length) {
    list.innerHTML = `<span class="hint-text">Файлов пока нет.</span>`;
    return;
  }
  attachments.forEach(a => {
    const row = document.createElement("div");
    row.className = "attachment-item";
    row.innerHTML = `
      <a href="/api/attachments/${a.id}/download">${escapeHtml(a.filename)}</a>
      <span class="size">${formatSize(a.size_bytes)}</span>
      <button class="remove-btn" title="Удалить">&times;</button>
    `;
    row.querySelector(".remove-btn").onclick = async () => {
      await API.del(`/api/attachments/${a.id}`);
      const task = await API.get(`/api/tasks/${openTaskId}`);
      renderAttachments(task.attachments);
      await loadState();
    };
    list.appendChild(row);
  });
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

function renderComments(comments) {
  const list = document.getElementById("tm-comments");
  list.innerHTML = "";
  if (!comments.length) {
    list.innerHTML = `<span class="hint-text">Комментариев пока нет.</span>`;
  }
  comments.forEach(c => {
    const author = userById(c.user_id);
    const row = document.createElement("div");
    row.className = "comment-item";
    row.innerHTML = `
      <div class="comment-head">
        <span class="author">${author ? escapeHtml(author.name) : "Удалённый участник"}</span>
        <span>${formatDateTime(c.created_at)}</span>
        <button class="remove-btn" title="Удалить">&times;</button>
      </div>
      <div class="comment-body">${escapeHtml(c.text)}</div>
    `;
    row.querySelector(".remove-btn").onclick = async () => {
      await API.del(`/api/comments/${c.id}`);
      const task = await API.get(`/api/tasks/${openTaskId}`);
      renderComments(task.comments);
      await loadState();
    };
    list.appendChild(row);
  });
}

function formatDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function renderTagPresets(activeTags) {
  const row = document.getElementById("tm-tag-presets");
  const active = new Set((activeTags || []).map(t => t.toLowerCase()));
  row.innerHTML = "";
  TAG_PRESETS.forEach(tag => {
    const chip = document.createElement("span");
    chip.className = "tag-preset-chip" + (active.has(tag.toLowerCase()) ? " active" : "");
    chip.textContent = tag;
    chip.addEventListener("click", () => toggleTagPreset(tag));
    row.appendChild(chip);
  });
}

function toggleTagPreset(tag) {
  const input = document.getElementById("tm-tags");
  const tags = input.value.split(",").map(s => s.trim()).filter(Boolean);
  const idx = tags.findIndex(t => t.toLowerCase() === tag.toLowerCase());
  if (idx === -1) tags.push(tag);
  else tags.splice(idx, 1);
  input.value = tags.join(", ");
  renderTagPresets(tags);
  updateSaveButtonState();
}

async function saveOpenTask(partial) {
  if (!openTaskId) return;
  await API.put(`/api/tasks/${openTaskId}`, partial);
  const hint = document.getElementById("tm-saved-hint");
  hint.textContent = "Сохранено";
  setTimeout(() => { hint.textContent = ""; }, 1200);
}

function bindGlobalEvents() {
  document.getElementById("search-input").addEventListener("input", e => {
    searchQuery = e.target.value;
    renderBoard();
  });

  const myTasksBtn = document.getElementById("my-tasks-btn");
  myTasksBtn.addEventListener("click", () => {
    onlyMine = !onlyMine;
    myTasksBtn.classList.toggle("toggle-active", onlyMine);
    renderBoard();
  });

  document.getElementById("current-user-select").addEventListener("change", e => {
    currentUserId = Number(e.target.value);
    localStorage.setItem("tb_current_user", currentUserId);
    if (onlyMine) renderBoard();
  });

  document.getElementById("new-task-btn").addEventListener("click", createAndOpenTask);
  document.getElementById("tm-column").addEventListener("change", updateSaveButtonState);

  // Горячие клавиши: "/" — фокус поиска, N — новая задача, Alt+M — фильтр «Мои задачи»
  document.addEventListener("keydown", e => {
    const target = e.target;
    const isTyping = target && (
      target.tagName === "INPUT" || target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT" || target.isContentEditable
    );
    if (e.key === "/" && !isTyping && !modalStack.length) {
      e.preventDefault();
      document.getElementById("search-input").focus();
    } else if ((e.key === "n" || e.key === "N" || e.key === "т" || e.key === "Т") && !isTyping && !modalStack.length) {
      e.preventDefault();
      createAndOpenTask();
    } else if (e.altKey && (e.key === "m" || e.key === "M" || e.key === "ь" || e.key === "Ь")) {
      e.preventDefault();
      myTasksBtn.click();
    }
  });

  // Кнопки-крестики и «Отмена» закрывают верхнюю модалку, в которой находятся
  document.querySelectorAll(".modal-overlay").forEach(ov => {
    ov.addEventListener("click", e => {
      if (e.target === ov && modalStack[modalStack.length - 1] === ov) {
        closeOverlay(ov);
      }
    });
  });
  document.querySelectorAll("[data-close]").forEach(btn => {
    btn.addEventListener("click", () => closeOverlay(btn.closest(".modal-overlay")));
  });

  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && modalStack.length) closeTopModal();
  });

  document.getElementById("tm-title").addEventListener("input", updateSaveButtonState);
  document.getElementById("tm-description").addEventListener("input", updateSaveButtonState);
  document.getElementById("tm-priority").addEventListener("change", updateSaveButtonState);
  document.getElementById("tm-assignee").addEventListener("change", updateSaveButtonState);
  document.getElementById("tm-due").addEventListener("change", updateSaveButtonState);
  document.getElementById("tm-tags").addEventListener("input", e => {
    const tags = e.target.value.split(",").map(s => s.trim()).filter(Boolean);
    renderTagPresets(tags);
    updateSaveButtonState();
  });

  document.getElementById("tm-save-btn").addEventListener("click", async () => {
    if (!openTaskId || !isTaskFormDirty()) return;
    const form = currentTaskFormValues();
    await saveOpenTask({
      title: form.title,
      description: form.description,
      priority: form.priority,
      assignee_id: form.assignee_id ? Number(form.assignee_id) : null,
      due_date: form.due_date,
      tags: form.tags.split(",").map(s => s.trim()).filter(Boolean),
    });
    if (form.column_id !== openTaskSnapshot.column_id) {
      await API.post(`/api/tasks/${openTaskId}/move`, { column_id: Number(form.column_id), position: 9999 });
    }
    await loadState();
    closeOverlay(document.getElementById("task-modal"));
  });

  document.getElementById("tm-delete").addEventListener("click", async () => {
    if (!openTaskId) return;
    const ok = await confirmDialog(
      "Удалить эту задачу без возможности восстановления?",
      { title: "Удалить задачу" }
    );
    if (!ok) return;
    await API.del(`/api/tasks/${openTaskId}`);
    closeOverlay(document.getElementById("task-modal"));
    openTaskId = null;
    await loadState();
  });

  document.getElementById("tm-comment-submit").addEventListener("click", async () => {
    const text = document.getElementById("tm-comment-text").value.trim();
    if (!text || !openTaskId) return;
    const userId = Number(document.getElementById("tm-comment-author").value);
    currentUserId = userId;
    localStorage.setItem("tb_current_user", userId);
    await API.post(`/api/tasks/${openTaskId}/comments`, { user_id: userId, text });
    document.getElementById("tm-comment-text").value = "";
    const task = await API.get(`/api/tasks/${openTaskId}`);
    renderComments(task.comments);
    await loadState();
  });

  document.getElementById("tm-subtask-add").addEventListener("click", addSubtaskFromModal);
  document.getElementById("tm-subtask-input").addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); addSubtaskFromModal(); }
  });

  document.getElementById("tm-file-input").addEventListener("change", async e => {
    const file = e.target.files[0];
    if (!file || !openTaskId) return;
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`/api/tasks/${openTaskId}/attachments`, { method: "POST", body: fd });
    if (!res.ok) { showToast("Не удалось загрузить файл"); return; }
    const task = await API.get(`/api/tasks/${openTaskId}`);
    renderAttachments(task.attachments);
    await loadState();
    e.target.value = "";
  });
}

let toastTimer;
function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2500);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}
