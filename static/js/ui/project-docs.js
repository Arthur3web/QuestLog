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
import { previewKind } from "../core/file-preview.js";
import { formatSize } from "../core/format.js";
import { confirmDialog } from "../core/modal.js";
import { showToast } from "../core/toast.js";

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
    // Правится только текст, и только свой: отпечаток файла не даст
    // затереть правку, сделанную снаружи, пока документ был открыт.
    editor: doc.preview === "text" ? documentEditor(doc) : null,
  }).then((shown) => {
    // Клик по строке не должен ничего не делать: если превью не вышло,
    // честно говорим об этом и отдаём файл на скачивание.
    if (shown) return;
    showToast("Файл слишком большой для предпросмотра — скачиваем его");
    triggerDownload(url);
  });
}

function documentEditor(doc) {
  // Отпечаток файла запоминаем при входе в правку и сверяем с ним при
  // сохранении: если файл трогали мимо приложения, сервер ответит 409
  // вместо того, чтобы молча затереть чужую правку.
  let stamp = null;
  return {
    async load() {
      const data = await API.get(`/api/project-documents/${doc.id}/content`);
      stamp = data.stamp;
      return data.text;
    },
    async save(text) {
      try {
        const updated = await API.put(`/api/project-documents/${doc.id}/content`, { text, stamp });
        if (ctx) await ctx.reload();
        showToast(`«${updated.filename}» сохранён`);
        return { ok: true };
      } catch (e) {
        showToast(String(e.message || e).includes("изменился")
          ? "Файл изменился на диске — закройте и откройте заново"
          : "Не удалось сохранить документ");
        return { error: true };
      }
    },
  };
}

// ------------------------------------------------------------
// Переименование прямо в строке (как у подзадач и комментариев)
// ------------------------------------------------------------
// Правка идёт в той же строке, без рамки: иначе строка растёт и кнопки
// справа уезжают вниз. Пока имя правится, карандаш становится галочкой —
// сохранить видно мышью, а не только по Enter, — и подпись с типом и
// размером подменяется подсказкой про клавиши: обе строки одной высоты.
//
// Правится только имя без расширения: расширение показывается рядом
// неприкосновенным текстом. Иначе можно назвать картинку «смета.txt» —
// содержимое останется картинкой, а подпись и просмотрщик соврут.
let activeRename = null;

function splitExtension(filename) {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return [filename, ""];
  return [filename.slice(0, dot), filename.slice(dot)];
}

function startRename(doc, row) {
  const nameNode = row.querySelector(".doc-name");
  if (!nameNode || row.querySelector(".doc-rename-input")) return;

  const metaNode = row.querySelector(".doc-meta");
  const renameBtn = row.querySelector(".doc-rename");
  const openTitle = renameBtn.getAttribute("title");
  const [baseName, extension] = splitExtension(doc.filename);

  const wrap = document.createElement("span");
  wrap.className = "doc-rename-wrap";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "doc-rename-input";
  input.value = baseName;
  input.spellcheck = false;
  wrap.appendChild(input);

  if (extension) {
    const suffix = document.createElement("span");
    suffix.className = "doc-rename-ext";
    suffix.textContent = extension;
    wrap.appendChild(suffix);
  }
  nameNode.replaceWith(wrap);

  const hint = document.createElement("span");
  hint.className = "doc-meta doc-rename-hint";
  hint.textContent = "Enter — сохранить, Esc — отмена";
  metaNode.replaceWith(hint);

  renameBtn.innerHTML = ICONS.check;
  renameBtn.title = "Сохранить (Enter)";
  renameBtn.setAttribute("aria-label", "Сохранить");
  input.focus();
  input.select();

  let settled = false;
  const finish = (save) => {
    if (settled) return;
    settled = true;
    activeRename = null;
    const name = input.value.trim();
    // Строку возвращаем в исходный вид в любом случае: после Esc поле иначе
    // осталось бы висеть, а карандаш — не на что было бы нажать.
    wrap.replaceWith(nameNode);
    hint.replaceWith(metaNode);
    renameBtn.innerHTML = ICONS.edit;
    renameBtn.title = openTitle;
    renameBtn.setAttribute("aria-label", "Переименовать");
    if (!save || !name || name === baseName) return;
    // Из поля правится только имя, но человек вполне может вставить
    // «протокол.txt» целиком. Приклеивать расширение к такому нельзя —
    // вышло бы «протокол.txt.png». Отбрасываем хвост, только если он
    // похож на настоящий тип файла, иначе это часть имени («схема.2»).
    const [typedBase, typedExt] = splitExtension(name);
    const cleanBase = typedExt && previewKind(`x${typedExt}`) ? typedBase : name;
    API.put(`/api/project-documents/${doc.id}`, { filename: cleanBase + extension })
      .then(() => { showToast("Файл переименован"); return ctx.reload(); })
      .catch((e) => showToast(String(e.message || e).includes("уже есть")
        ? "Документ с таким именем уже есть"
        : "Не удалось переименовать файл"));
  };

  activeRename = { row, save: () => finish(true) };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); return; }
    if (e.key !== "Escape") return;
    e.preventDefault();
    // Гасим событие: дальше по документу его слушает панель проекта, и без
    // этого Escape отменял бы правку и закрывал ящик целиком.
    e.stopPropagation();
    input.value = baseName;
    finish(false);
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
  const renameBtn = row.querySelector(".doc-rename");
  // Клик по кнопке не должен снимать фокус с поля: иначе blur сохранил бы
  // имя, а следующий обработчик тут же открыл бы правку заново.
  renameBtn.addEventListener("mousedown", (e) => e.preventDefault());
  renameBtn.addEventListener("click", () => {
    if (activeRename && activeRename.row === row) { activeRename.save(); return; }
    startRename(doc, row);
  });
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

  // Создание документа на месте: обновления в проекте пишутся здесь же,
  // а из документов раньше можно было только загрузить готовый файл.
  const newForm = byId("docs-new-form");
  const newName = byId("docs-new-name");
  const newOpen = byId("docs-new-open");
  // Пока форма открыта, кнопка «+ создать» рядом не нужна — в форме есть
  // своя «Создать». Иначе два рядом стоящих начала работы обоих сбивают.
  const closeNewForm = () => {
    newForm.hidden = true;
    newOpen.hidden = false;
    newName.value = "";
  };
  newOpen.addEventListener("click", () => {
    newForm.hidden = false;
    newOpen.hidden = true;
    newName.focus();
  });
  // Escape закрывает форму и возвращает фокус на кнопку, её открывшую.
  // stopPropagation обязателен: дальше по документу слушает панель проекта,
  // и без него закрылся бы ещё и ящик целиком.
  newForm.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    closeNewForm();
    newOpen.focus();
  });
  byId("docs-new-cancel").addEventListener("click", closeNewForm);
  newForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!ctx) return;
    const name = newName.value.trim();
    if (!name) return;
    try {
      const doc = await API.post(`/api/boards/${ctx.boardId}/documents/text`, {
        filename: name,
        text: "",
      });
      closeNewForm();
      await ctx.reload();
      showToast(`Документ «${doc.filename}» создан`);
    } catch (err) {
      const message = String(err.message || err);
      showToast(message.includes("уже есть") ? "Документ с таким именем уже есть"
        : "Не удалось создать документ");
    }
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