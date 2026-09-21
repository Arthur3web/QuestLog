// ==========================================================
// Стек модальных окон + promise-диалог подтверждения.
//
// Стек нужен, чтобы Escape и кнопки-крестики всегда закрывали
// ИМЕННО верхнее окно: подтверждение удаления может открыться
// поверх модалки задачи.
// ==========================================================

import { byId } from "./dom.js";

const modalStack = [];
const onCloseCallbacks = new Map(); // overlay id -> callback

export function openOverlay(id, onClose) {
  const ov = byId(id);
  if (!ov) return null;
  if (modalStack.includes(ov)) return ov;
  ov.classList.remove("hidden");
  modalStack.push(ov);
  if (onClose) onCloseCallbacks.set(id, onClose);
  return ov;
}

export function closeOverlay(ov) {
  if (!ov) return;
  const idx = modalStack.lastIndexOf(ov);
  if (idx !== -1) modalStack.splice(idx, 1);
  ov.classList.add("hidden");
  const cb = onCloseCallbacks.get(ov.id);
  if (cb) {
    onCloseCallbacks.delete(ov.id);
    cb();
  }
}

export function closeTopModal() {
  closeOverlay(modalStack[modalStack.length - 1]);
}

export function isModalOpen() {
  return modalStack.length > 0;
}

export function showModal(id, onClose) {
  openOverlay(id, onClose);
}
export function hideModal(id) {
  closeOverlay(byId(id));
}

// Promise-based confirm dialog (no native window.confirm)
export function confirmDialog(
  message,
  { title = "Подтверждение", okLabel = "Удалить", danger = true } = {},
) {
  return new Promise((resolve) => {
    byId("confirm-title").textContent = title;
    byId("confirm-text").textContent = message;
    const ok = byId("confirm-ok");
    ok.textContent = okLabel;
    ok.className = danger ? "btn-danger" : "btn-primary";

    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      ok.onclick = null;
      byId("confirm-cancel").onclick = null;
      closeOverlay(byId("confirm-modal"));
      resolve(value);
    };
    ok.onclick = () => finish(true);
    byId("confirm-cancel").className = "btn-secondary";
    byId("confirm-cancel").onclick = () => finish(false);

    openOverlay("confirm-modal", () => finish(false));
    setTimeout(() => ok.focus(), 30);
  });
}

// Escape закрывает верхнюю модалку. Один слушатель на всё приложение.
export function bindModalEscape() {
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modalStack.length) closeTopModal();
  });

  // Модалки закрываются ТОЛЬКО явными кнопками (крестик / «Отмена» / «Закрыть»)
  // или Escape: случайный клик по фону больше не закрывает окно и не теряет данные.
  document.querySelectorAll("[data-close]").forEach((btn) => {
    btn.addEventListener("click", () =>
      closeOverlay(btn.closest(".modal-overlay")),
    );
  });
}
