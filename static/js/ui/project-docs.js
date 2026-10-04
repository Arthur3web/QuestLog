// ==========================================================
// Документы проекта: хранилище файлов конкретной доски.
//
// Загрузка — выбором файла или перетаскиванием в панель, просмотр —
// тем же встроенным просмотрщиком, что и у вложений задачи
// (core/file-preview.js): поддерживаемые форматы открываются прямо
// здесь, неподдерживаемые — отдаются на скачивание.
// ==========================================================

import { API } from "../core/api.js";
import { byId, escapeHtml } from "../core/dom.js";
import { ICONS } from "../core/icons.js";
import { formatSize } from "../core/format.js";
import { confirmDialog } from "../core/modal.js";
import { showToast } from "../core/toast.js";
import { openFileLightbox } from "../core/file-preview.js";

// Совпадает с лимитом запроса на сервере (MAX_UPLOAD_MB).
const MAX_UPLOAD_MB = 25;

let ctx = null;
let uploading = false;

function downloadUrl(doc) {
  return `/api/project-documents/${doc.id}/download`;
}

function setStatus(text) {
  const status = byId("docs-status");
  status.hidden = !text;
  status.textContent = text || "";
}

function formatStamp(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("ru-RU", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

// Подпись типа: показываем, умеет ли приложение открыть такой файл.
function previewLabel(kind) {
  if (kind === "image") return "Картинка";
  if (kind === "pdf") return "PDF";
  if (kind === "text") return "Текст";
  return "Файл"; // формат приложение не показывает — остаётся скачать
}

// ------------------------------------------------------------
// Загрузка
// ------------------------------------------------------------
async function uploadFiles(files) {
  if (!ctx || uploading) return;
  const list = Array.from(files || []).filter(f => f && f.name);
  if (!list.length) return;

  uploading = true;
  byId("docs-file-input").disabled = true;
  document.querySelector("#pane-docs .project-upload").classList.add("disabled");

  let failed = 0;
  let tooBig = 0;
  for (let i = 0; i < list.length; i += 1) {
    setStatus(`Загрузка ${i + 1} из ${list.length}: ${list[i].name}`);
    const formData = new FormData();
    formData.append("file", list[i]);
    try {
      const res = await API.upload(`/api/boards/${ctx.boardId}/documents`, formData);
      if (!res.ok) {
        // 413 — тело запроса больше лимита; остальные файлы могли загрузиться.
        if (res.status === 413) tooBig += 1;
        else failed += 1;
      }
    } catch (e) {
      failed += 1;
    }
  }

  uploading = false;
  byId("docs-file-input").disabled = false;
  document.querySelector("#pane-docs .project-upload").classList.remove("disabled");
  setStatus("");
  await ctx.reload();

  if (!failed && !tooBig) showToast(list.length > 1 ? `Загружено файлов: ${list.length}` : "Файл загружен");
  else if (failed && tooBig) showToast(`Не загружено файлов: ${failed + tooBig}. Лимит одного файла — ${MAX_UPLOAD_MB} МБ`);
  else if (tooBig) showToast(`Файл больше лимита ${MAX_UPLOAD_MB} МБ — не загружен`);
  else showToast(`Не удалось загрузить файлов: ${failed}`);
}

// ------------------------------------------------------------
// Открытие файла: превью или скачивание
// ------------------------------------------------------------
// Скачивание через невидимую ссылку, а не window.open: вкладка могла бы
// остаться висеть, если бы сервер ответил inline, и страница бы уехала.
function triggerDownload(url) {
  const link = document.createElement("a");
  link.href = url;
  link.download = "";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function openDoc(doc) {
  const url = downloadUrl(doc);
  if (!doc.preview) {
    triggerDownload(url);
    return;
  }
  openFileLightbox({
    url,
    filename: doc.filename,
    size_bytes: doc.size_bytes,
  }).then((shown) => {
    // Клик по строке не должен ничего не делать: если превью не вышло,
    // честно говорим об этом и отдаём файл на скачивание.
    if (shown) return;
    showToast("Файл слишком большой для предпросмотра — скачиваем его");
    triggerDownload(url);
  });
}

// ------------------------------------------------------------
// Переименование прямо в строке (как у подзадач и комментариев)
// ------------------------------------------------------------
function startRename(doc, row) {
  const nameNode = row.querySelector(".doc-name");
  if (!nameNode || row.querySelector(".doc-rename-input")) return;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "doc-rename-input";
  input.value = doc.filename;
  input.spellcheck = false;
  nameNode.replaceWith(input);
  input.focus();
  input.select();

  let settled = false;
  const finish = (save) => {
    if (settled) return;
    settled = true;
    const name = input.value.trim();
    if (save && name && name !== doc.filename) {
      API.put(`/api/project-documents/${doc.id}`, { filename: name })
        .then(() => { showToast("Файл переименован"); return ctx.reload(); })
        .catch(() => showToast("Не удалось переименовать файл"));
      return;
    }
    if (!save && name !== doc.filename) return ctx.reload();
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); input.blur(); }
    if (e.key === "Escape") {
      e.preventDefault();
      input.value = doc.filename;
      input.blur();
    }
  });
  input.addEventListener("blur", () => finish(true));
}

// ------------------------------------------------------------
// Список файлов
// ------------------------------------------------------------
function renderRow(doc) {
  const row = document.createElement("div");
  row.className = "doc-item";
  const canPreview = Boolean(doc.preview);

  // Слева — только то, что действительно открывается: у превьюиваемых файлов
  // это кнопка-глаз. Скачивание уже есть справа отдельной кнопкой, поэтому
  // для файлов без превью слева стоит знак «файл» — без рамки и без курсора.
  const mark = canPreview
    ? `<button type="button" class="doc-open" title="Открыть в приложении" aria-label="Открыть">${ICONS.eye}</button>`
    : `<span class="doc-file-mark" title="Формат приложение не показывает — остаётся скачать">${ICONS.file}</span>`;

  row.innerHTML = `
    ${mark}
    <div class="doc-main">
      <span class="doc-name" title="${escapeHtml(doc.filename)}">${escapeHtml(doc.filename)}</span>
      <span class="doc-meta">${escapeHtml(previewLabel(doc.preview))} · ${escapeHtml(formatSize(doc.size_bytes))} · ${escapeHtml(formatStamp(doc.updated_at))}</span>
    </div>
    <div class="doc-actions">
      <button type="button" class="preview-btn doc-rename" title="Переименовать" aria-label="Переименовать">${ICONS.edit}</button>
      <a class="preview-btn doc-download" href="${downloadUrl(doc)}" title="Скачать" aria-label="Скачать">${ICONS.download}</a>
      <button type="button" class="remove-btn doc-delete" title="Удалить" aria-label="Удалить">${ICONS.close}</button>
    </div>
  `;

  if (canPreview) row.querySelector(".doc-open").addEventListener("click", () => openDoc(doc));
  row.querySelector(".doc-rename").addEventListener("click", () => startRename(doc, row));
  row.querySelector(".doc-delete").addEventListener("click", async () => {
    const ok = await confirmDialog(
      `Удалить документ «${doc.filename}»?`,
      { title: "Удалить документ", okLabel: "Удалить" },
    );
    if (!ok) return;
    try {
      await API.del(`/api/project-documents/${doc.id}`);
      await ctx.reload();
      showToast("Документ удалён");
    } catch (e) {
      showToast("Не удалось удалить документ");
    }
  });

  return row;
}

export function renderProjectDocs(pane, context) {
  ctx = context;
  const list = byId("docs-list");
  if (!list) return;

  byId("docs-download-all").disabled = false;
  list.innerHTML = "";

  if (!context.data.documents.length) {
    list.innerHTML = `
      <div class="project-empty">
        <p>Документов пока нет.</p>
        <p class="hint-text">Загрузите файлы проекта — схемы, сметы, договоры. Они хранятся в папке этой доски и не привязаны к задачам.</p>
      </div>`;
    return;
  }
  context.data.documents.forEach(doc => list.appendChild(renderRow(doc)));
}

// ------------------------------------------------------------
// Привязка (один раз на старте)
// ------------------------------------------------------------
export function bindProjectDocs() {
  const input = byId("docs-file-input");
  input.addEventListener("change", (e) => {
    const files = Array.from(e.target.files);
    e.target.value = ""; // чтобы повторный выбор того же файла сработал
    uploadFiles(files);
  });

  // Одно действие на всё: из вкладки документов тоже отдаётся досье,
  // а не только документация — иначе пришлось бы держать два архива.
  byId("docs-download-all").addEventListener("click", () => {
    if (ctx) window.location.href = `/api/boards/${ctx.boardId}/dossier`;
  });

  // Перетаскивание файлов в панель документов.
  const pane = byId("pane-docs");
  const hasFiles = e => Array.from(e.dataTransfer ? e.dataTransfer.types : []).includes("Files");

  // Файлы гасим на уровне документа: иначе браузер откроет перетащенный
  // файл вместо страницы приложения. Само событие drop гасим только
  // внутри панели — перетаскивание карточек по доске должно работать.
  document.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener("drop", (e) => { if (hasFiles(e)) e.preventDefault(); });

  pane.addEventListener("dragover", (e) => {
    if (!hasFiles(e) || uploading) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    pane.classList.add("drop-active");
  });
  pane.addEventListener("dragleave", (e) => {
    // dragleave приходит и при переходе между элементами внутри панели,
    // поэтому снимаем подсветку, только когда курсор ушёл из панели.
    if (!pane.contains(e.relatedTarget)) pane.classList.remove("drop-active");
  });
  pane.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    pane.classList.remove("drop-active");
    uploadFiles(e.dataTransfer.files);
  });
}