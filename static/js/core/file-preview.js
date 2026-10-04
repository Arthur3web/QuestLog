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
export async function openFileLightbox({ url, filename, size_bytes }) {
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

// Один раз на старте: крестик и клик по фону закрывают просмотрщик.
export function bindFileLightbox() {
  const box = byId("attachment-lightbox");
  if (!box) return;
  byId("lightbox-close").addEventListener("click", closeFileLightbox);
  box.addEventListener("click", (e) => {
    if (e.target === box) closeFileLightbox();
  });
}