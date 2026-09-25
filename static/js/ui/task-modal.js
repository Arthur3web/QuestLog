// ==========================================================
// Модальное окно задачи и всё, что внутри него:
// поля, подзадачи, вложения, комментарии.
//
// Это единственное место, которое знает, как устроена форма
// задачи, — остальные модули открывают её через openTaskModal().
// ==========================================================

import { API } from "../core/api.js";
import { byId, escapeHtml, initials } from "../core/dom.js";
import { ICONS } from "../core/icons.js";
import { formatSize, formatDateTime, formatDuration, formatTimeRange } from "../core/format.js";
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
  autoGrowDescription();
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

  byId("tm-comment-text").value = "";
  updateCommentSubmitState();

  renderSubtasks(task.subtasks);
  renderAttachments(task.attachments);
  renderComments(task.comments);
  renderTimeTracking(task);
  byId("tm-time-section").style.display = isNew ? "none" : "";

  byId("tm-subtask-input").value = "";
  updateSubtaskAddState();

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

  // Пересчитываем высоту поля описания ПОСЛЕ открытия модалки:
  // на момент заполнения она ещё была hidden (display:none), а у
  // скрытого элемента scrollHeight = 0 — поле осталось бы низким.
  // То же самое касается textarea подзадач: они отрисованы выше,
  // пока модалка была скрыта.
  requestAnimationFrame(() => {
    autoGrowDescription();
    document.querySelectorAll(".subtask-item .subtask-title")
      .forEach(autosizeSubtaskField);
  });

  if (selectTitle) {
    setTimeout(() => { titleInput.focus(); titleInput.select(); }, 40);
  }
}

// ------------------------------------------------------------
// Поле описания растёт под текст
//
// Большое описание должно быть видно целиком, но в рамках модалки:
// поле растёт по содержимому до ограничения по высоте, дальше появляется
// внутренняя прокрутка — модалка при этом не разъезжается.
// ------------------------------------------------------------
export function autoGrowDescription() {
  const ta = byId("tm-description");
  if (!ta) return;
  // Сначала сбрасываем высоту, иначе при удалении текста она не уменьшается.
  ta.style.height = "auto";
  const max = Math.round(window.innerHeight * 0.5);
  ta.style.height = Math.min(ta.scrollHeight, max) + "px";
  ta.style.overflowY = ta.scrollHeight > max ? "auto" : "hidden";
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
// Textarea подзадачи растёт под текст (от 1 строки), поэтому длинное
// название видно целиком — без отдельной кнопки-раскрывашки.
function autosizeSubtaskField(el) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = el.scrollHeight + "px";
}

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
    // Название подзадачи — textarea, а не input: длинный текст
    // переносится и виден целиком, без отдельной кнопки-раскрывашки.
    row.innerHTML = `
      <input type="checkbox" ${s.done ? "checked" : ""}>
      <textarea class="subtask-title" rows="1" spellcheck="false">${escapeHtml(s.title)}</textarea>
      <button class="remove-btn" title="Удалить">${ICONS.close}</button>
    `;
    const checkbox = row.querySelector('input[type="checkbox"]');
    const titleInput = row.querySelector(".subtask-title");
    // Пересчёт высоты при вводе названия.
    titleInput.addEventListener("input", () => autosizeSubtaskField(titleInput));
    checkbox.addEventListener("change", async () => {
      const taskId = openTaskId;
      if (!taskId) return; // модалку успели закрыть
      await API.put(`/api/subtasks/${s.id}`, { done: checkbox.checked });
      const task = await API.get(`/api/tasks/${taskId}`);
      renderSubtasks(task.subtasks);
      await loadState();
    });
    titleInput.addEventListener("blur", async () => {
      const taskId = openTaskId;
      const value = titleInput.value.trim();
      if (!value) { titleInput.value = s.title; return; }
      if (value === s.title) return;
      if (!taskId) return;
      await API.put(`/api/subtasks/${s.id}`, { title: value });
      const task = await API.get(`/api/tasks/${taskId}`);
      renderSubtasks(task.subtasks);
      await loadState();  // обновить счётчик подзадач на карточке
    });
    titleInput.addEventListener("keydown", e => {
      // Enter сохраняет, Shift+Enter — перенос строки внутри названия.
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); titleInput.blur(); }
    });
    row.querySelector(".remove-btn").addEventListener("click", async () => {
      const taskId = openTaskId;
      const ok = await confirmDialog(
        `Удалить подзадачу «${s.title}»?`,
        { title: "Удалить подзадачу" }
      );
      if (!ok || !taskId) return;
      await API.del(`/api/subtasks/${s.id}`);
      const task = await API.get(`/api/tasks/${taskId}`);
      renderSubtasks(task.subtasks);
      await loadState();
    });
    list.appendChild(row);
    // Высоту считаем только ПОСЛЕ вставки в DOM: у отдельного элемента
    // scrollHeight = 0, и textarea осталась бы высотой в одну строку.
    autosizeSubtaskField(titleInput);
  });
}

export async function addSubtaskFromModal() {
  const input = byId("tm-subtask-input");
  const title = input.value.trim();
  if (!title || !openTaskId) return;
  const taskId = openTaskId;
  await API.post(`/api/tasks/${taskId}/subtasks`, { title });
  input.value = "";
  updateSubtaskAddState();
  const task = await API.get(`/api/tasks/${taskId}`);
  renderSubtasks(task.subtasks);
  await loadState();
  input.focus();
}

// Кнопка «+ добавить» неактивна, пока поле новой подзадачи пусто.
export function updateSubtaskAddState() {
  const btn = byId("tm-subtask-add");
  const input = byId("tm-subtask-input");
  if (btn && input) btn.disabled = input.value.trim().length === 0;
}

// ------------------------------------------------------------
// Вложения
// ------------------------------------------------------------
function closeLightbox() {
  const lightbox = byId("attachment-lightbox");
  if (!lightbox) return;
  lightbox.classList.add("hidden");
  byId("lightbox-image").removeAttribute("src");
}

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
        img.alt = a.filename;
        byId("attachment-lightbox").classList.remove("hidden");
      });
    } else {
      link.addEventListener("click", e => {
        e.preventDefault();
        window.open(downloadUrl, "_blank");
      });
    }
    row.querySelector(".remove-btn").onclick = async () => {
      const taskId = openTaskId;
      if (!taskId) return;
      await API.del(`/api/attachments/${a.id}`);
      const task = await API.get(`/api/tasks/${taskId}`);
      renderAttachments(task.attachments);
      await loadState();
    };
    list.appendChild(row);
  });
}

export async function uploadAttachmentFromModal(file, input) {
  if (!file || !openTaskId) return;
  const taskId = openTaskId;
  const fd = new FormData();
  fd.append("file", file);
  const res = await API.upload(`/api/tasks/${taskId}/attachments`, fd);
  if (!res.ok) { showToast("Не удалось загрузить файл"); return; }
  const task = await API.get(`/api/tasks/${taskId}`);
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
      const taskId = openTaskId;
      if (!taskId) return;
      await API.del(`/api/comments/${c.id}`);
      const task = await API.get(`/api/tasks/${taskId}`);
      if (taskId === openTaskId) renderComments(task.comments);
      await loadState();
    };
    list.appendChild(row);
  });
}

export async function submitCommentFromModal() {
  const text = byId("tm-comment-text").value.trim();
  if (!text || !openTaskId) return;
  const taskId = openTaskId;
  const userId = Number(byId("tm-comment-author").value);
  setCurrentUserId(userId);
  await API.post(`/api/tasks/${taskId}/comments`, { user_id: userId, text });
  if (taskId !== openTaskId) return;
  byId("tm-comment-text").value = "";
  updateCommentSubmitState();
  const task = await API.get(`/api/tasks/${taskId}`);
  if (taskId !== openTaskId) return;
  renderComments(task.comments);
  await loadState();
}

// Кнопка «Отправить» неактивна, пока текст комментария пуст (или одни
// пробелы) — чтобы нельзя было отправить пустой комментарий.
export function updateCommentSubmitState() {
  const btn = byId("tm-comment-submit");
  const input = byId("tm-comment-text");
  if (btn && input) btn.disabled = input.value.trim().length === 0;
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
    const authorName = author ? author.name : "Удалённый участник";
    // Инициалы и цвет — те же, что в карточках доски: строка перестаёт
    // быть безликой, когда записей несколько.
    const avatar = author
      ? `<span class="avatar time-avatar" style="background:${author.color}" title="${escapeHtml(authorName)}">${escapeHtml(initials(authorName))}</span>`
      : `<span class="avatar time-avatar" style="background:#666">?</span>`;
    row.innerHTML = `
      <div class="time-entry-head">
        ${avatar}
        <span class="time-author">${escapeHtml(authorName)}</span>
        <span class="time-range">${escapeHtml(formatTimeRange(e.started_at, e.stopped_at))}</span>
        <span class="time-duration">${e.stopped_at ? formatDuration(e.duration_seconds) : "идёт…"}</span>
        <button class="remove-btn" title="Удалить запись">${ICONS.close}</button>
      </div>
    `;
    row.querySelector(".remove-btn").addEventListener("click", async () => {
      const ok = await confirmDialog("Удалить эту запись времени?", { title: "Удалить запись" });
      if (!ok) return;
      const taskId = openTaskId;
      if (!taskId) return;
      await API.del(`/api/time-entries/${e.id}`);
      const fresh = await API.get(`/api/tasks/${taskId}`);
      renderTimeTracking(fresh);
      await loadState();
    });
    list.appendChild(row);
  });
}

async function toggleTimerFromModal() {
  const taskId = openTaskId;
  if (!taskId) return;
  const task = await API.get(`/api/tasks/${taskId}`);
  if (task.timer_running) {

    await API.post(`/api/tasks/${taskId}/timer/stop`, {});
  } else {
    const userId = currentUserId || (state.users[0] && state.users[0].id);
    if (!userId) { showToast("Сначала выберите участника («Я:»)"); return; }
    setCurrentUserId(userId);
    await API.post(`/api/tasks/${taskId}/timer/start`, { user_id: userId });
  }
  const fresh = await API.get(`/api/tasks/${taskId}`);
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
  const form = currentTaskFormValues();
  try {
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
  } catch (e) {
    // Раньше taskSaved выставлялся до запроса: при сетевой ошибке закрытие
    // модалки могло удалить несохранённую новую задачу.
    showToast("Не удалось сохранить задачу. Подробности — в консоли (F12).");
    console.error("[QuestLog] Сохранение задачи не удалось:", e);
    return;
  }
  taskSaved = true;
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
  byId("tm-description").addEventListener("input", () => {
    autoGrowDescription();
    updateSaveButtonState();
  });
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
  byId("tm-subtask-input").addEventListener("input", updateSubtaskAddState);
  byId("tm-subtask-input").addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); addSubtaskFromModal(); }
  });
  updateSubtaskAddState();

  // Комментарии
  byId("tm-comment-submit").addEventListener("click", submitCommentFromModal);
  // Кнопка отправки активна только при непустом тексте
  byId("tm-comment-text").addEventListener("input", updateCommentSubmitState);
  byId("tm-comment-text").addEventListener("keydown", e => {
    // Ctrl/Cmd+Enter отправляет комментарий — привычный шоткат
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submitCommentFromModal();
    }
  });

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
