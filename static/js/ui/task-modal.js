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
  currentBoardId,
  setOpenTask, clearOpenTask,
} from "../domain/store.js";
import { openOverlay, closeOverlay, confirmDialog } from "../core/modal.js";
import { showToast } from "../core/toast.js";
import { loadState } from "../domain/state-loader.js";

let taskSaved = false;
// Режим «создание задачи»: задача ещё НЕ записана в БД и будет создана
// одним POST-запросом по кнопке «Создать». В этом режиме скрыты секции
// подзадач/вложений/комментариев (им нечего показывать), кнопка «Удалить»
// и закрытие окна ничего не пишет и не удаляет.
let creatingNew = false;
// Дефолты полей формы в режиме создания (колонка, срок из календаря и т.п.)
let createDefaults = null;

// ------------------------------------------------------------
// Модалка задачи
// ------------------------------------------------------------
export async function openTaskModal(taskId, { selectTitle = false } = {}) {
  creatingNew = false;
  taskSaved = true;
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

  byId("tm-subtask-input").value = "";
  updateSubtaskAddState();

  // В режиме редактирования все секции и «Удалить» всегда видимы
  // (в т.ч. «Время», скрытая в форме создания),
  // а нижняя кнопка снова называется «Закрыть».
  for (const id of ["tm-subtasks-section", "tm-attachments-section", "tm-comments-section", "tm-time-section"]) {
    byId(id).style.display = "";
  }
  byId("tm-delete").style.visibility = "";
  byId("tm-cancel-btn").textContent = "Закрыть";

  const ov = openOverlay("task-modal", async () => {
    clearTimerTicker();
    clearOpenTask();
  });
  if (ov && !ov.dataset.boundTitle) {
    // Заголовок модалки повторяет название задачи (только в режиме
    // редактирования: в форме создания заголовок — «Новая задача»).
    titleInput.addEventListener("input", e => {
      if (!creatingNew) byId("tm-heading").textContent = e.target.value.trim() || "Задача";
    });
    // Enter в названии в режиме создания = кнопка «Создать».
    titleInput.addEventListener("keydown", e => {
      if (creatingNew && e.key === "Enter") {
        e.preventDefault();
        saveOpenTaskFromModal();
      }
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
// Режим создания: форма открыта, но задачи в БД ещё нет.
// Запись создаётся одним POST по кнопке «Создать» (или Enter
// в названии); «Отмена»/Escape просто закрывают окно.
// ------------------------------------------------------------
export async function openNewTaskModal({ dueDate = "" } = {}) {
  creatingNew = true;
  taskSaved = false; // таймер-тикер уже не нужен, но флаг держит консистентность
  if (!currentUserId && state.users.length) setCurrentUserId(state.users[0].id);
  const col = state.columns.find(c => !c.is_done_state) || state.columns[0];
  createDefaults = { column_id: col ? String(col.id) : "", dueDate };

  const titleInput = byId("tm-title");
  titleInput.value = "";
  titleInput.classList.remove("tm-invalid");
  byId("tm-title-hint").hidden = true;
  byId("tm-priority").value = "normal";
  byId("tm-due").value = dueDate || "";
  byId("tm-tags").value = "";
  byId("tm-description").value = "";
  renderTagPresets([]);

  const columnSel = byId("tm-column");
  columnSel.innerHTML = state.columns.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
  columnSel.value = createDefaults.column_id;

  const assigneeSel = byId("tm-assignee");
  assigneeSel.innerHTML = `<option value="">Без исполнителя</option>` +
    state.users.map(u => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join("");
  assigneeSel.value = currentUserId || "";

  // Снапшот пустой формы: «Создать» активна, когда название непустое
  // (даже если всё совпадает с дефолтами).
  setOpenTask(null, {
    title: "",
    description: "",
    priority: "normal",
    assignee_id: String(currentUserId || ""),
    due_date: dueDate || "",
    tags: "",
    column_id: createDefaults.column_id,
  });
  updateSaveButtonState();

  // Секции с контентом задачи в форме создания не нужны:
  // им пока нечего показывать.
  for (const id of ["tm-subtasks-section", "tm-attachments-section", "tm-comments-section", "tm-time-section"]) {
    byId(id).style.display = "none";
  }
  byId("tm-delete").style.visibility = "hidden";

  byId("tm-cancel-btn").textContent = "Отмена";

  // Открытие/закрытие ничего не пишет и не удаляет.
  openOverlay("task-modal", () => {
    clearTimerTicker();
    clearOpenTask();
    createDefaults = null;
  });

  byId("tm-heading").textContent = "Новая задача";

  requestAnimationFrame(() => {
    autoGrowDescription();
    titleInput.focus();
  });
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
  // Максимума больше нет: описание видно целиком всегда; длинный текст
  // прокручивается вместе со всей модалкой.
  ta.style.height = "auto";
  ta.style.height = ta.scrollHeight + "px";
  ta.style.overflowY = "hidden";
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
  if (!btn) return;
  if (creatingNew) {
    // Создание: достаточно непустого названия — остальное есть дефолты.
    btn.textContent = "Создать";
    btn.disabled = byId("tm-title").value.trim().length === 0;
    return;
  }
  btn.textContent = "Сохранить";
  btn.disabled = !isTaskFormDirty();
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
// Что можно показать прямо в лайтбоксе. Картинки — в <img> (в этом контексте
// SVG не выполняет свой скрипт), PDF — во фрейме, текстовые файлы — в <pre>.
const IMAGE_PREVIEW_RE = /\.(jpg|jpeg|png|gif|webp|svg|bmp|ico)$/i;
const PDF_PREVIEW_RE = /\.pdf$/i;
const TEXT_PREVIEW_RE = /\.(txt|md|markdown|log|csv|tsv|json|xml|ya?ml|ini|cfg|conf|toml|env|py|js|mjs|cjs|ts|tsx|jsx|css|html?|sh|bash|bat|cmd|ps1|sql|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|vue|gitignore|editorconfig)$/i;
// Текст больше этого размера не тянем в браузер — предлагаем скачать файл.
const MAX_TEXT_PREVIEW_BYTES = 256 * 1024;

function previewKind(filename) {
  if (IMAGE_PREVIEW_RE.test(filename)) return "image";
  if (PDF_PREVIEW_RE.test(filename)) return "pdf";
  if (TEXT_PREVIEW_RE.test(filename)) return "text";
  return null;
}

function resetLightboxMedia() {
  const image = byId("lightbox-image");
  const frame = byId("lightbox-frame");
  const text = byId("lightbox-text");
  image.removeAttribute("src");
  frame.removeAttribute("src");
  text.textContent = "";
  image.hidden = true;
  frame.hidden = true;
  text.hidden = true;
}

function closeLightbox() {
  const lightbox = byId("attachment-lightbox");
  if (!lightbox || lightbox.classList.contains("hidden")) return;
  resetLightboxMedia();
  // Лайтбокс живёт в том же стеке модалок: Escape закрывает именно его,
  // а не карточку задачи под ним (иначе потерялись бы несохранённые правки).
  closeOverlay(lightbox);
}

async function openLightbox(attachment) {
  const kind = previewKind(attachment.filename);
  if (!kind) return false;
  if (kind === "text" && attachment.size_bytes > MAX_TEXT_PREVIEW_BYTES) {
    showToast("Файл слишком большой для предпросмотра — скачиваем его");
    return false;
  }
  const url = `/api/attachments/${attachment.id}/download`;
  resetLightboxMedia();
  byId("lightbox-name").textContent = attachment.filename;

  const text = byId("lightbox-text");
  if (kind === "image") {
    const image = byId("lightbox-image");
    image.src = url;
    image.alt = attachment.filename;
    image.hidden = false;
  } else if (kind === "pdf") {
    const frame = byId("lightbox-frame");
    // Фрейму нужен ответ inline: с Content-Disposition: attachment браузер
    // скачивает PDF вместо показа.
    frame.src = `${url}?inline=1`;
    frame.hidden = false;
  } else {
    text.textContent = "Загрузка…";
    text.hidden = false;
  }
  openOverlay("attachment-lightbox");

  if (kind === "text") {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(String(res.status));
      // textContent, а не innerHTML: содержимое файла не должно стать HTML.
      text.textContent = await res.text();
    } catch (e) {
      closeLightbox();
      showToast("Не удалось открыть файл");
      return false;
    }
  }
  return true;
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
    const kind = previewKind(a.filename);
    const linkTitle = kind ? "Открыть превью" : "Скачать";
    row.innerHTML = `
      <a href="${downloadUrl}" title="${linkTitle}">${escapeHtml(a.filename)}</a>
      <div class="attachment-meta">
        <span class="size">${formatSize(a.size_bytes)}</span>
        <button type="button" class="remove-btn" title="Удалить">${ICONS.close}</button>
      </div>
    `;
    const link = row.querySelector("a");
    link.addEventListener("click", e => {
      e.preventDefault();
      if (!kind) {
        window.open(downloadUrl, "_blank");
        return;
      }
      // Кнопки «Скачать» в превью нет, поэтому если его открыть не удалось
      // (например, текст оказался слишком большим), отдаём файл напрямую —
      // иначе клик по имени не делал бы ничего.
      openLightbox(a).then(shown => {
        if (!shown) window.open(downloadUrl, "_blank");
      });
    });
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

export async function uploadAttachmentsFromModal(files) {
  const taskId = openTaskId;
  const list = Array.from(files || []).filter(f => f && f.name);
  if (!taskId || !list.length) return;
  let failed = 0;
  for (const file of list) {
    const fd = new FormData();
    fd.append("file", file);
    const res = await API.upload(`/api/tasks/${taskId}/attachments`, fd);
    if (!res.ok) failed += 1;
  }
  const task = await API.get(`/api/tasks/${taskId}`);
  renderAttachments(task.attachments);
  await loadState();
  if (failed === list.length) showToast("Не удалось загрузить файл");
  else if (failed) showToast(`Не удалось загрузить файлов: ${failed}`);
}

// Перетаскивание файлов: цель — вся модалка задачи, подсветка — блок вложений.
function bindAttachmentDrop() {
  const overlay = byId("task-modal");
  const section = byId("tm-attachments-section");
  if (!overlay || !section) return;

  const hasFiles = e => Array.from(e.dataTransfer ? e.dataTransfer.types : []).includes("Files");

  // Иначе браузер открывает перетащенный файл вместо страницы. Гасим только
  // файлы — перетаскиванию карточек по доске это не мешает.
  document.addEventListener("dragover", e => { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener("drop", e => { if (hasFiles(e)) e.preventDefault(); });

  overlay.addEventListener("dragover", e => {
    if (!openTaskId || !hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    section.classList.add("drop-active");
  });
  overlay.addEventListener("dragleave", e => {
    // dragleave приходит и при переходе между элементами внутри окна,
    // поэтому снимаем подсветку, только когда курсор ушёл из модалки.
    if (!overlay.contains(e.relatedTarget)) section.classList.remove("drop-active");
  });
  overlay.addEventListener("drop", async e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    section.classList.remove("drop-active");
    await uploadAttachmentsFromModal(e.dataTransfer.files);
  });
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
        <button class="edit-btn" title="Редактировать">${ICONS.edit}</button>
        <button class="remove-btn" title="Удалить">${ICONS.close}</button>
      </div>
      <div class="comment-body">${escapeHtml(c.text)}</div>
      <div class="comment-editor" hidden>
        <textarea rows="2" spellcheck="false">${escapeHtml(c.text)}</textarea>
        <div class="comment-editor-actions">
          <button class="btn-secondary comment-cancel">Отмена</button>
          <button class="btn-primary comment-save" disabled>Сохранить</button>
        </div>
      </div>
    `;
    const body = row.querySelector(".comment-body");
    const editor = row.querySelector(".comment-editor");
    const ta = editor.querySelector("textarea");
    const saveBtn = editor.querySelector(".comment-save");

    const startEdit = () => {
      body.hidden = true;
      editor.hidden = false;
      ta.value = c.text;
      autosizeTextarea(ta);
      saveBtn.disabled = ta.value.trim() === c.text.trim();
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    };
    const stopEdit = () => {
      editor.hidden = true;
      body.hidden = false;
    };

    row.querySelector(".edit-btn").onclick = startEdit;
    row.querySelector(".comment-cancel").onclick = stopEdit;

    ta.addEventListener("input", () => {
      autosizeTextarea(ta);
      saveBtn.disabled = ta.value.trim() === c.text.trim() || ta.value.trim() === "";
    });
    ta.addEventListener("keydown", e => {
      // Ctrl/Cmd+Enter сохраняет — как у композера новых комментариев
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (!saveBtn.disabled) saveBtn.click(); }
      if (e.key === "Escape") { e.preventDefault(); stopEdit(); }
    });
    saveBtn.onclick = async () => {
      const text = ta.value.trim();
      if (!text || text === c.text.trim()) return;
      const taskId = openTaskId;
      if (!taskId) return;
      try {
        await API.put(`/api/comments/${c.id}`, { text });
        c.text = text;
        stopEdit();
        body.textContent = text;
      } catch (e) {
        showToast("Не удалось сохранить комментарий");
        console.error("[QuestLog] Сохранение комментария не удалось:", e);
      }
    };

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

// Авторост textarea редактора комментария под текст
function autosizeTextarea(ta) {
  ta.style.height = "auto";
  ta.style.height = ta.scrollHeight + "px";
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
// Создание / сохранение / удаление задачи
// ------------------------------------------------------------
export async function saveOpenTaskFromModal() {
  if (creatingNew) {
    const titleInput = byId("tm-title");
    const title = titleInput.value.trim();
    if (!title) {
      // Попытка отправить без названия: красная рамка на поле и
      // подсказка; снимутся, как только пользователь начнёт набирать.
      titleInput.classList.add("tm-invalid");
      byId("tm-title-hint").hidden = false;
      titleInput.focus();
      return;
    }
    // Проверки названия достаточно: срок может быть любым
    // (в т.ч. в прошлом — это нормально для задач задним числом).
    const form = currentTaskFormValues();
    try {
      await API.post("/api/tasks", {
        board_id: currentBoardId,
        column_id: Number(form.column_id),
        title,
        description: form.description,
        priority: form.priority,
        assignee_id: form.assignee_id ? Number(form.assignee_id) : null,
        due_date: form.due_date,
        tags: form.tags.split(",").map(s => s.trim()).filter(Boolean),
      });
    } catch (e) {
      showToast("Не удалось создать задачу. Подробности — в консоли (F12).");
      console.error("[QuestLog] Создание задачи не удалось:", e);
      return;
    }
    creatingNew = false;
    createDefaults = null;
    await loadState();
    closeOverlay(byId("task-modal"));
    return;
  }
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
  // В форме создания удалять нечего — кнопка там и так скрыта.
  if (!openTaskId || creatingNew) return;
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
  byId("tm-title").addEventListener("input", e => {
    // Валидная подпись снимает красную рамку и подсказку валидации
    if (e.target.value.trim()) {
      e.target.classList.remove("tm-invalid");
      byId("tm-title-hint").hidden = true;
    }
    updateSaveButtonState();
  });
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

  // Вложения: выбор в диалоге и перетаскивание файлов в окно задачи
  byId("tm-file-input").addEventListener("change", e => {
    const files = Array.from(e.target.files);
    e.target.value = "";
    uploadAttachmentsFromModal(files);
  });
  bindAttachmentDrop();

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
}
