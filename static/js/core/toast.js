// ==========================================================
// Всплывающие уведомления внизу экрана.
// ==========================================================

import { byId } from "./dom.js";

let toastTimer;

export function showToast(msg) {
  const t = byId("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2500);
}
