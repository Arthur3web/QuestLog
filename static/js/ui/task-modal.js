// ==========================================================
// Модальное окно задачи и всё, что внутри него:
// поля, подзадачи, вложения, комментарии.
//
// Это единственное место, которое знает, как устроена форма
// задачи, — остальные модули открывают её через openTaskModal().
// ==========================================================

import { API } from "../core/api.js";
import { byId, escapeHtml } from "../core/dom.js";
import { ICONS } from "../core/icons.js";
import { formatSize, formatDateTime, formatDuration } from "../core/format.js";
import { TAG_PRESETS } from "../core/config.js";
import {
  state, userById,
  openTaskId, openTaskSnapshot,
  currentUserId, setCurrentUserId,
  setOpenTask, clearOpenTask,
} from "../domain/store.js";
import { openOverlay, closeOverlay, confirmDialog } from "../core/modal.js";
import { showToast } from "../core/toast.js";
import { loadState } from "../domain/state-loader.js";

let taskSaved = false;

// ------------------------------------------------------------
// Модалка задачи
// ------------------------------------------------------------
export async function openTaskModal(taskId, { selectTitle = false, isNew = false } = {}) {
  taskSaved = !isNew;
  const task = await API.get(`/api/tasks/${taskId}`);

  const titleInput = byId("tm-title");
  titleInput.value = task.title;
  byId("tm-priority").value = task.priority;
  byId("tm-due").value = task.due_date || "";
  byId("tm-tags").value = task.tags.join(", ");
  byId("tm-description").value = task.description || "";
  renderTagPresets(task.tags);

  const columnSel = byId("tm-column");
  columnSel.innerHTML = state.columns.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
  columnSel.value = task.column_id;

  const assigneeSel = byId("tm-assignee");
  assigneeSel.innerHTML = `<option value="">Без исполнителя</option>` +
    state.users.map(u => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join("");
  assigneeSel.value = task.assignee_id || "";

  setOpenTask(taskId, {
    title: task.title,
    description: task.description || "",
    priority: task.priority,
    assignee_id: String(task.assignee_id || ""),
    due_date: task.due_date || "",
    tags: task.tags.join(", "),
    column_id: String(task.column_id),
  });
  updateSaveButtonState();

  const authorSel = byId("tm-comment-author");
  authorSel.innerHTML = state.users.map(u => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join("");
  authorSel.value = currentUserId || (state.users[0] && state.users[0].id) || "";

  renderSubtasks(task.subtasks);
  renderAttachments(task.attachments);
  renderComments(task.comments);
  renderTimeTracking(task);

  const ov = openOverlay("task-modal", async () => {
    clearTimerTicker();
    if (openTaskId && !taskSaved) {
      try {
        await API.del(`/api/tasks/${openTaskId}`);
        await loadState();
      } catch (e) { /* игнор */ }
    }
    clearOpenTask();
  });
  if (ov && !ov.dataset.boundTitle) {
    // Заголовок модалки повторяет название задачи
    titleInput.addEventListener("input", e => {
      byId("tm-heading").textContent = e.target.value.trim() || "Задача";
    });
    ov.dataset.boundTitle = "1";
  }
  byId("tm-heading").textContent = task.title || "Задача";

  if (selectTitle) {
    setTimeout(() => { titleInput.focus(); titleInput.select(); }, 40);
  }
}

// Модалка при любом закрытии сбрасывается к значениям по умолчанию,
// чтобы следующий запуск не показывал данные предыдущей задачи.
export function resetTaskModalForm() {
  taskSaved = false;
  byId("tm-title").value = "";
  byId("tm-description").value = "";
  byId("tm-priority").value = "normal";
  byId("tm-assignee").innerHTML = `<option value="">Без исполнителя</option>`;
  byId("tm-assignee").value = "";
  byId("tm-due").value = "";
  byId("tm-tags").value = "";
  byId("tm-column").innerHTML = "";
  byId("tm-subtasks").innerHTML = "";
  byId("tm-subtasks-progress").textContent = "";
  byId("tm-attachments").innerHTML = "";
  byId("tm-comments").innerHTML = "";
  byId("tm-time-total").textContent = "";
  byId("tm-time-log").innerHTML = "";
  byId("tm-timer-display").textContent = "0с";
  byId("tm-timer-toggle").textContent = "▶ Старт";
  byId("tm-timer-toggle").classList.remove("timer-active");
  byId("tm-heading").textContent = "Задача";
  byId("tm-saved-hint").textContent = "";
  renderTagPresets([]);
  const saveBtn = byId("tm-save-btn");
  if (saveBtn) saveBtn.disabled = true;
  clearOpenTask();
}

// ------------------------------------------------------------
// Отслеживание несохранённых изменений («Сохранить» активна)
// ------------------------------------------------------------
function currentTaskFormValues() {
  return {
    title: byId("tm-title").value,
    description: byId("tm-description").value,
    priority: byId("tm-priority").value,
    assignee_id: byId("tm-assignee").value,
    due_date: byId("tm-due").value,
    tags: byId("tm-tags").value.split(",").map(s => s.trim()).filter(Boolean).join(", "),
    column_id: byId("tm-column").value,
  };
}

function isTaskFormDirty() {
  if (!openTaskSnapshot) return false;
  const cur = currentTaskFormValues();
  return Object.keys(openTaskSnapshot).some(key => cur[key] !== openTaskSnapshot[key]);
}

export function updateSaveButtonState() {
  const btn = byId("tm-save-btn");
  if (btn) btn.disabled = !isTaskFormDirty();
}

// ------------------------------------------------------------
// Подзадачи
// ------------------------------------------------------------
function renderSubtasks(subtasks) {
  const list = byId("tm-subtasks");
  const progress = byId("tm-subtasks-progress");
  list.innerHTML = "";
  const done = subtasks.filter(s => s.done).length;
  const total = subtasks.length;
  // Прогресс одной строкой в заголовке секции: [▓▓░░░] 2/5.
  // Цвет зависит от уровня выполнения: до половины — тревожный, дальше — нейтральный, 100% — зелёный.
  if (total) {
    const ratio = done / total;
    const level = ratio === 1 ? " complete" : ratio >= 0.5 ? " mid" : " low";
    progress.innerHTML =
      `<span class="bar${level}"><span class="b">[</span>${"▓".repeat(done)}${"░".repeat(total - done)}<span class="b">]</span></span>` +
      ` ${done}/${total}`;
  } else {
    progress.textContent = "";
  }
  if (!total) {
    list.innerHTML = `<span class="hint-text">Подзадач пока нет.</span>`;
    return;
  }
  subtasks.forEach(s => {
    const row = document.createElement("div");
    row.className = "subtask-item" + (s.done ? " done" : "");
    row.innerHTML = `
      <input type="checkbox" ${s.done ? "checked" : ""}>
      <input type="text" class="subtask-title" value="${escapeHtml(s.title)}">
      <button class="remove-btn" title="Удалить">${ICONS.close}</button>
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
      await loadState();  // обновить счётчик подзадач на карточке
    });
    titleInput.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); titleInput.blur(); }
    });
    row.querySelector(".remove-btn").addEventListener("click", async () => {
      const ok = await confirmDialog(
        `Удалить подзадачу «${s.title}»?`,
        { title: "Удалить подзадачу" }
      );
      if (!ok) return;
      await API.del(`/api/subtasks/${s.id}`);
      const task = await API.get(`/api/tasks/${openTaskId}`);
      renderSubtasks(task.subtasks);
      await loadState();
    });
    list.appendChild(row);
  });
}

export async function addSubtaskFromModal() {
  const input = byId("tm-subtask-input");
  const title = input.value.trim();
  if (!title || !openTaskId) return;
  await API.post(`/api/tasks/${openTaskId}/subtasks`, { title });
  input.value = "";
  const task = await API.get(`/api/tasks/${openTaskId}`);
  renderSubtasks(task.subtasks);
  await loadState();
  input.focus();
}

// ------------------------------------------------------------
// Вложения
// ------------------------------------------------------------
function isImageFile(filename) {
  return /\.(jpg|jpeg|png|gif|webp|svg|bmp|ico)$/i.test(filename);
}

function renderAttachments(attachments) {
  const list = byId("tm-attachments");
  list.innerHTML = "";
  if (!attachments.length) {
    list.innerHTML = `<span class="hint-text">Файлов пока нет.</span>`;
    return;
  }
  attachments.forEach(a => {
    const downloadUrl = `/api/attachments/${a.id}/download`;
    const row = document.createElement("div");
    row.className = "attachment-item";
    const isImage = isImageFile(a.filename);
    const linkTitle = isImage ? "Открыть превью" : "Скачать";
    row.innerHTML = `
      <a href="${downloadUrl}" title="${linkTitle}">${escapeHtml(a.filename)}</a>
      <div class="attachment-meta">
        <span class="size">${formatSize(a.size_bytes)}</span>
        <button type="button" class="remove-btn" title="Удалить">${ICONS.close}</button>
      </div>
    `;
    const link = row.querySelector("a");
    if (isImage) {
      link.addEventListener("click", e => {
        e.preventDefault();
        const img = byId("lightbox-image");
        img.src = downloadUrl;
        byId("attachment-lightbox").classList.remove("hidden");
      });
    } else {
      link.addEventListener("click", e => {
        e.preventDefault();
        window.open(downloadUrl, "_blank");
      });
    }
    row.querySelector(".remove-btn").onclick = async () => {
      await API.del(`/api/attachments/${a.id}`);
      const task = await API.get(`/api/tasks/${openTaskId}`);
      renderAttachments(task.attachments);
      await loadState();
    };
    list.appendChild(row);
  });
}

export async function uploadAttachmentFromModal(file, input) {
  if (!file || !openTaskId) return;
  const fd = new FormData();
  fd.append("file", file);
  const res = await API.upload(`/api/tasks/${openTaskId}/attachments`, fd);
  if (!res.ok) { showToast("Не удалось загрузить файл"); return; }
  const task = await API.get(`/api/tasks/${openTaskId}`);
  renderAttachments(task.attachments);
  await loadState();
  input.value = "";
}

// ------------------------------------------------------------
// Комментарии
// ------------------------------------------------------------
function renderComments(comments) {
  const list = byId("tm-comments");
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
        <button class="remove-btn" title="Удалить">${ICONS.close}</button>
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

export async function submitCommentFromModal() {
  const text = byId("tm-comment-text").value.trim();
  if (!text || !openTaskId) return;
  const userId = Number(byId("tm-comment-author").value);
  setCurrentUserId(userId);
  await API.post(`/api/tasks/${openTaskId}/comments`, { user_id: userId, text });
  byId("tm-comment-text").value = "";
  const task = await API.get(`/api/tasks/${openTaskId}`);
  renderComments(task.comments);
  await loadState();
}

// ------------------------------------------------------------
// Время: старт/стоп таймер и лог затраченного времени
// ------------------------------------------------------------
let timerTicker = null;

function clearTimerTicker() {
  if (timerTicker) { clearInterval(timerTicker);
  timerTicker = null;
  }
}

// Секунды, прошедшие с момента старта активной(незакрытой) записи
function activeElapsedSeconds(task) {
  const active = (task.time_entries || []).find(e => !e.stopped_at);
  if (!active) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(active.started_at).getTime()) / 1000));
}

function renderTimeTracking(task) {
  const entries = task.time_entries || [];
  const totalSeconds = task.time_spent_seconds || 0;
  const runningBool = !!task.timer_running;

  byId("tm-time-total").textContent = totalSeconds > 0 || runningBool
    ? `Итого: ${formatDuration(totalSeconds)}` : "";

  const toggle = byId("tm-timer-toggle");
  toggle.textContent = runningBool ? "■ Стоп" : "▶ Старт";
  toggle.classList.toggle("timer-active", runningBool);

  const display = byId("tm-timer-display");
  display.classList.toggle("live", runningBool);
  clearTimerTicker();
  if (runningBool) {
    const tick = () => {
      display.textContent = formatDuration(totalSeconds + activeElapsedSeconds(task));
    };
    tick();
    timerTicker = setInterval(tick, 1000);
  } else {
    display.textContent = formatDuration(totalSeconds);
  }

  const note = byId("tm-timer-note");
  note.textContent = runningBool ? "идёт учёт времени — не забудьте остановить" : "";

  const list = byId("tm-time-log");
  list.innerHTML = "";
  if (!entries.length) {
    list.innerHTML = `<span class="hint-text">Записей времени пока нет. Запустите таймер, чтобы начать учёт.</span>`;
    return;
  }
  entries.forEach(e => {
    const author = userById(e.user_id);
    const row = document.createElement("div");
    row.className = "time-entry-item" + (e.stopped_at ? "" : " running");
    const when = e.stopped_at
      ? `${formatDateTime(e.started_at)} — ${formatDateTime(e.stopped_at)}`
      : `старт ${formatDateTime(e.started_at)}`;
    row.innerHTML = `
      <div class="time-entry-head">
        <span class="time-author">${author ? escapeHtml(author.name) : "Удалённый участник"}</span>
        <span class="time-range">${escapeHtml(when)}</span>
        <span class="time-duration">${e.stopped_at ? formatDuration(e.duration_seconds) : "идёт…"}</span>
        <button class="remove-btn" title="Удалить запись">${ICONS.close}</button>
      </div>
    `;
    row.querySelector(".remove-btn").addEventListener("click", async () => {
      const ok = await confirmDialog("Удалить эту запись времени?", { title: "Удалить запись" });
      if (!ok) return;
      await API.del(`/api/time-entries/${e.id}`);
      const fresh = await API.get(`/api/tasks/${openTaskId}`);
      renderTimeTracking(fresh);
      await loadState();
    });
    list.appendChild(row);
  });
}

async function toggleTimerFromModal() {
  if (!openTaskId) return;
  const task = await API.get(`/api/tasks/${openTaskId}`);
  if (task.timer_running) {

    await API.post(`/api/tasks/${openTaskId}/timer/stop`, {});
  } else {
    const userId = currentUserId || (state.users[0] && state.users[0].id);
    if (!userId) { showToast("Сначала выберите участника («Я:»)"); return; }
    setCurrentUserId(userId);
    await API.post(`/api/tasks/${openTaskId}/timer/start`, { user_id: userId });
  }
  const fresh = await API.get(`/api/tasks/${openTaskId}`);
  renderTimeTracking(fresh);
  await loadState();
}

// ------------------------------------------------------------
// Теги-пресеты
// ------------------------------------------------------------
export function renderTagPresets(activeTags) {
  const row = byId("tm-tag-presets");
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
  const input = byId("tm-tags");
  const tags = input.value.split(",").map(s => s.trim()).filter(Boolean);
  const idx = tags.findIndex(t => t.toLowerCase() === tag.toLowerCase());
  if (idx === -1) tags.push(tag);
  else tags.splice(idx, 1);
  input.value = tags.join(", ");
  renderTagPresets(tags);
  updateSaveButtonState();
}

// ------------------------------------------------------------
// Сохранение / удаление задачи
// ------------------------------------------------------------
export async function saveOpenTaskFromModal() {
  if (!openTaskId || !isTaskFormDirty()) return;
  taskSaved = true;
  const form = currentTaskFormValues();
  await API.put(`/api/tasks/${openTaskId}`, {
    title: form.title,
    description: form.description,
    priority: form.priority,
    assignee_id: form.assignee_id ? Number(form.assignee_id) : null,
    due_date: form.due_date,
    tags: form.tags.split(",").map(s => s.trim()).filter(Boolean),
  });
  if (form.column_id !== openTaskSnapshot.column_id) {
    await API.post(`/api/tasks/${openTaskId}/move`, {
      column_id: Number(form.column_id),
      position: 9999,
    });
  }
  await loadState();
  closeOverlay(byId("task-modal"));
}

export async function deleteOpenTask() {
  if (!openTaskId) return;
  const ok = await confirmDialog(
    "Удалить эту задачу без возможности восстановления?",
    { title: "Удалить задачу" }
  );
  if (!ok) return;
  await API.del(`/api/tasks/${openTaskId}`);
  closeOverlay(byId("task-modal"));
  clearOpenTask();
  await loadState();
}
// ------------------------------------------------------------
// Привязка событий формы задачи (один раз на старте)
// ------------------------------------------------------------
export function bindTaskModal() {
  // Отслеживание изменений полей — включает кнопку «Сохранить»
  byId("tm-title").addEventListener("input", updateSaveButtonState);
  byId("tm-description").addEventListener("input", updateSaveButtonState);
  byId("tm-priority").addEventListener("change", updateSaveButtonState);
  byId("tm-assignee").addEventListener("change", updateSaveButtonState);
  byId("tm-due").addEventListener("change", updateSaveButtonState);
  byId("tm-column").addEventListener("change", updateSaveButtonState);
  byId("tm-tags").addEventListener("input", e => {
    const tags = e.target.value.split(",").map(s => s.trim()).filter(Boolean);
    renderTagPresets(tags);
    updateSaveButtonState();
  });

  byId("tm-save-btn").addEventListener("click", saveOpenTaskFromModal);
  byId("tm-delete").addEventListener("click", deleteOpenTask);

  // Подзадачи
  byId("tm-subtask-add").addEventListener("click", addSubtaskFromModal);
  byId("tm-subtask-input").addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); addSubtaskFromModal(); }
  });

  // Комментарии
  byId("tm-comment-submit").addEventListener("click", submitCommentFromModal);

  // Таймер
  byId("tm-timer-toggle").addEventListener("click", toggleTimerFromModal);

  // Вложения
  byId("tm-file-input").addEventListener("change", e => {
    uploadAttachmentFromModal(e.target.files[0], e.target);
  });

  // Превью вложений — лайтбокс
  byId("lightbox-close").innerHTML = ICONS.close;
  byId("lightbox-close").addEventListener("click", () => {
    closeLightbox();
  });
  byId("attachment-lightbox").addEventListener("click", e => {
    if (e.target === byId("attachment-lightbox")) {
      closeLightbox();
    }
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && !byId("attachment-lightbox").classList.contains("hidden")) {
      closeLightbox();
    }
  });
}
