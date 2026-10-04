// ==========================================================
// Просмотр файлов в приложении: один просмотрщик на вложения
// задач и документы проекта.
//
// Правила те же, что были у вложений: картинка — в <img>, PDF —
// во фрейме, текст — в <pre>. HTML и SVG в список не входят
// намеренно: встроенные в страницу приложения, они выполнили бы
// свой скрипт на том же origin и получили бы доступ к API.
// ==========================================================

import { byId } from "./dom.js";
import { openOverlay, closeOverlay } from "./modal.js";

const IMAGE_PREVIEW_RE = /\.(jpg|jpeg|png|gif|webp|svg|bmp|ico)$/i;
const PDF_PREVIEW_RE = /\.pdf$/i;
const TEXT_PREVIEW_RE = /\.(txt|md|markdown|log|csv|tsv|json|xml|ya?ml|ini|cfg|conf|toml|env|py|js|mjs|cjs|ts|tsx|jsx|css|html?|sh|bash|bat|cmd|ps1|sql|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|vue|gitignore|editorconfig)$/i;
// Текст больше этого размера не тянем в браузер — предлагаем скачать файл.
const MAX_TEXT_PREVIEW_BYTES = 256 * 1024;

// Какой просмотрщик умеет показать такой файл: image | pdf | text | null
export function previewKind(filename) {
  if (IMAGE_PREVIEW_RE.test(filename)) return "image";
  if (PDF_PREVIEW_RE.test(filename)) return "pdf";
  if (TEXT_PREVIEW_RE.test(filename)) return "text";
  return null;
}

export function isLightboxOpen() {
  const box = byId("attachment-lightbox");
  return Boolean(box && !box.classList.contains("hidden"));
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
  const editor = byId("lightbox-editor");
  editor.value = "";
  editor.hidden = true;
  byId("lightbox-edit").hidden = true;
  byId("lightbox-edit-actions").hidden = true;
}

export function closeFileLightbox() {
  if (!isLightboxOpen()) return;
  resetLightboxMedia();
  // Лайтбокс живёт в стеке модалок: Escape закрывает именно его,
  // а не карточку задачи под ним (иначе потерялись бы несохранённые правки).
  closeOverlay(byId("attachment-lightbox"));
}

// Показать файл в лайтбоксе. Возвращает false, если показать нечем
// (неизвестный тип или слишком большой текст) — вызывающий код тогда
// отдаёт файл на скачивание.
//
// editor (необязательный) разрешает правку: у документа проекта это
// {load(), save(text)} — он открывает редактор прямо в просмотрщике.
// У вложений задач editor не передаётся, и правки там нет вовсе.
export async function openFileLightbox({ url, filename, size_bytes, editor }) {
  const kind = previewKind(filename);
  if (!kind) return false;
  if (kind === "text" && size_bytes > MAX_TEXT_PREVIEW_BYTES) return false;

  resetLightboxMedia();
  byId("lightbox-name").textContent = filename;

  const text = byId("lightbox-text");
  if (kind === "image") {
    const image = byId("lightbox-image");
    image.src = url;
    image.alt = filename;
    image.hidden = false;
  } else if (kind === "pdf") {
    const frame = byId("lightbox-frame");
    // Фрейму нужен ответ inline: с Content-Disposition: attachment
    // браузер скачивает PDF вместо показа.
    frame.src = `${url}?inline=1`;
    frame.hidden = false;
  } else {
    text.textContent = "Загрузка…";
    text.hidden = false;
    // Править имеет смысл только текст, и только если вызывающий дал
    // обработчики сохранения.
    byId("lightbox-edit").hidden = !editor;
    activeEditor = editor || null;
  }
  openOverlay("attachment-lightbox");

  if (kind === "text") {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(String(res.status));
      // textContent, а не innerHTML: содержимое файла не должно стать HTML.
      text.textContent = await res.text();
    } catch (e) {
      closeFileLightbox();
      return false;
    }
  }
  return true;
}

// Правка текста прямо в просмотрщике: тот же <pre> меняется на <textarea>,
// чтобы не плодить второе окно поверх первого.
let activeEditor = null;

function enterEditMode() {
  if (!activeEditor) return;
  const text = byId("lightbox-text");
  const editor = byId("lightbox-editor");
  // Правка всегда стартует от того, что лежит на диске сейчас: заодно
  // вызывающий запомнит отпечаток файла, по которому потом проверит сохранение.
  Promise.resolve(activeEditor.load()).then((fresh) => {
    editor.value = typeof fresh === "string" ? fresh : text.textContent;
  }).catch(() => {
    editor.value = text.textContent;
  });
  text.hidden = true;
  editor.hidden = false;
  byId("lightbox-edit").hidden = true;
  byId("lightbox-edit-actions").hidden = false;
  editor.focus();
}

function leaveEditMode() {
  const text = byId("lightbox-text");
  const editor = byId("lightbox-editor");
  editor.hidden = true;
  text.hidden = false;
  byId("lightbox-edit").hidden = !activeEditor;
  byId("lightbox-edit-actions").hidden = true;
}

// Один раз на старте: крестик и клик по фону закрывают просмотрщик.
export function bindFileLightbox() {
  const box = byId("attachment-lightbox");
  if (!box) return;
  byId("lightbox-close").addEventListener("click", closeFileLightbox);
  box.addEventListener("click", (e) => {
    if (e.target === box) closeFileLightbox();
  });
  byId("lightbox-edit").addEventListener("click", enterEditMode);
  byId("lightbox-cancel-edit").addEventListener("click", leaveEditMode);
  byId("lightbox-save").addEventListener("click", async () => {
    if (!activeEditor) return;
    const editor = byId("lightbox-editor");
    const save = byId("lightbox-save");
    save.disabled = true;
    try {
      const result = await activeEditor.save(editor.value);
      if (result && result.error) return; // вызывающий уже сказал человеку почему
      byId("lightbox-text").textContent = editor.value;
      leaveEditMode();
    } finally {
      save.disabled = false;
    }
  });
  // Ctrl/Cmd+S — привычное сочетание для сохранения длинного текста.
  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.key !== "s") return;
    if (byId("lightbox-editor").hidden || !isLightboxOpen()) return;
    e.preventDefault();
    byId("lightbox-save").click();
  });
}