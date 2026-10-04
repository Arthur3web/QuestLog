// ==========================================================
// Лента событий проекта: кто что сделал и когда.
//
// Записи появляются сами из тех же действий, что меняют доску, —
// здесь их только читают. Поэтому событие не может разойтись с
// реальностью: записать его можно лишь вместе с изменением.
// ==========================================================

import { API } from "../core/api.js";
import { byId, escapeHtml } from "../core/dom.js";
import { copyText } from "../core/clipboard.js";
import { formatDateTime } from "../core/format.js";
import { showToast } from "../core/toast.js";
import { userById } from "../domain/store.js";

// Иконка по типу события — та же логика, что у точек в ленте отчёта.
const KIND_ICON = {
  task_created: "+",
  task_updated: "~",
  task_moved: "→",
  task_deleted: "−",
  column_created: "+",
  column_renamed: "~",
  column_deleted: "−",
  doc_added: "+",
  doc_renamed: "~",
  doc_deleted: "−",
  update_added: "+",
  update_edited: "~",
  update_deleted: "−",
  project_renamed: "~",
  project_description: "~",
  sharing_changed: "•",
};

function actorName(userId) {
  if (!userId) return "Кто-то";
  const user = userById(userId);
  return user ? user.name : "Удалённый участник";
}

export function renderProjectEvents(pane, context) {
  const list = byId("events-list");
  if (!list) return;
  const events = context.data.events || [];

  // Пересказ за период — над списком: сначала «что изменилось»,
  // потом детали того, как именно.
  const digest = byId("events-digest");
  const digestText = byId("events-digest-text");
  if (digest && digestText) {
    digestText.textContent = context.data.digest || "";
    digest.hidden = !context.data.digest;
  }

  list.innerHTML = "";
  if (!events.length) {
    list.innerHTML = `
      <li class="project-empty">
        <p>Событий пока нет.</p>
        <p class="hint-text">История начнёт наполняться, как только в доске начнут меняться задачи и документы.</p>
      </li>`;
    return;
  }

  events.forEach((event) => {
    const row = document.createElement("li");
    row.className = "project-event";
    row.innerHTML = `
      <span class="project-event-mark" aria-hidden="true">${KIND_ICON[event.kind] || "•"}</span>
      <div class="project-event-body">
        <span class="project-event-text">${escapeHtml(event.text)}</span>
        <span class="project-event-meta">${escapeHtml(actorName(event.user_id))} · ${escapeHtml(formatDateTime(event.created_at))}</span>
      </div>
    `;
    list.appendChild(row);
  });
}

export function bindProjectEvents() {
  // Отдельной кнопки обновления нет: вкладка и так перечитывает данные
  // при каждом открытии, а лишний контрол только занимал бы место.

  byId("events-digest-copy").addEventListener("click", async () => {
    const text = byId("events-digest-text").textContent.trim();
    if (!text) return;
    showToast(await copyText(text) ? "Пересказ скопирован" : "Скопируйте текст вручную");
  });
}