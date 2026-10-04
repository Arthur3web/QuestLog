// ==========================================================
// Обновления проекта: компактная хронология изменений.
//
// Записи добавляются, правятся и удаляются теми же кнопками, что
// и комментарии к задаче: система прав в приложении одна, роли у
// пользователей не различаются.
// ==========================================================

import { API } from "../core/api.js";
import { byId, escapeHtml } from "../core/dom.js";
import { ICONS } from "../core/icons.js";
import { confirmDialog } from "../core/modal.js";
import { showToast } from "../core/toast.js";
import { currentUserId } from "../domain/store.js";

// Контекст текущей панели: {boardId, data, reload}. Ставится при каждой
// отрисовке вкладки, чтобы кнопки формы знали, куда сохранять.
let ctx = null;
let editingId = null; // id правимой записи; null — создаётся новая

function todayKey() {
  const now = new Date();
  const pad = n => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// Дата в компактном виде, но с годом: у changelog «04.03» без года
// неоднозначно.
function formatUpdateDate(value) {
  const d = new Date(`${value}T00:00:00`);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
}

// ------------------------------------------------------------
// Форма: новая запись или правка существующей
// ------------------------------------------------------------
function openForm(update) {
  editingId = update ? update.id : null;
  const form = byId("update-form");
  form.hidden = false;
  byId("update-title").value = update ? update.title : "";
  byId("update-text").value = update ? update.text : "";
  byId("update-date").value = update ? update.entry_date : todayKey();
  byId("update-submit").textContent = update ? "Сохранить" : "Добавить";
  byId("update-title").focus();
}

function closeForm() {
  editingId = null;
  byId("update-form").hidden = true;
  byId("update-title").value = "";
  byId("update-text").value = "";
}

function updateSubmitState() {
  byId("update-submit").disabled = byId("update-title").value.trim().length === 0;
}

async function submitForm() {
  if (!ctx) return;
  const payload = {
    title: byId("update-title").value.trim(),
    text: byId("update-text").value,
    entry_date: byId("update-date").value || todayKey(),
  };
  if (!payload.title) return;

  const isEdit = editingId !== null;
  const btn = byId("update-submit");
  btn.disabled = true;
  try {
    if (isEdit) {
      await API.put(`/api/project-updates/${editingId}`, payload);
    } else {
      await API.post(`/api/boards/${ctx.boardId}/updates`, { ...payload, user_id: currentUserId });
    }
    closeForm();
    await ctx.reload();
    showToast(isEdit ? "Изменения сохранены" : "Обновление добавлено");
  } catch (e) {
    showToast("Не удалось сохранить обновление");
    updateSubmitState();
  }
}

// ------------------------------------------------------------
// Отрисовка хронологии
// ------------------------------------------------------------
function renderRow(update) {
  const row = document.createElement("li");
  row.className = "project-update";
  row.innerHTML = `
    <div class="project-update-body">
      <div class="project-update-head">
        <span class="project-update-date">${escapeHtml(formatUpdateDate(update.entry_date))}</span>
        <span class="project-update-title">${escapeHtml(update.title)}</span>
      </div>
      ${update.text ? `<div class="project-update-text">${escapeHtml(update.text)}</div>` : ""}
      <div class="project-update-actions">
        <button type="button" class="edit-btn" title="Редактировать">${ICONS.edit}</button>
        <button type="button" class="remove-btn" title="Удалить">${ICONS.close}</button>
      </div>
    </div>
  `;

  row.querySelector(".edit-btn").addEventListener("click", () => openForm(update));
  row.querySelector(".remove-btn").addEventListener("click", async () => {
    const ok = await confirmDialog(
      `Удалить обновление «${update.title}»?`,
      { title: "Удалить обновление", okLabel: "Удалить" },
    );
    if (!ok) return;
    try {
      await API.del(`/api/project-updates/${update.id}`);
      await ctx.reload();
      showToast("Обновление удалено");
    } catch (e) {
      showToast("Не удалось удалить обновление");
    }
  });
  return row;
}

export function renderProjectUpdates(pane, context) {
  ctx = context;
  const list = byId("update-list");
  if (!list) return;

  list.innerHTML = "";
  list.classList.toggle("is-empty", context.data.updates.length === 0);
  if (!context.data.updates.length) {
    list.innerHTML = `
      <li class="project-empty">
        <p>Обновлений пока нет.</p>
        <p class="hint-text">Сюда удобно писать, что изменилось в проекте: решения, релизы, сдвиги сроков.</p>
      </li>`;
    return;
  }
  context.data.updates.forEach(update => list.appendChild(renderRow(update)));
}

// ------------------------------------------------------------
// Привязка (один раз на старте)
// ------------------------------------------------------------
export function bindProjectUpdates() {
  byId("update-add-open").addEventListener("click", () => openForm(null));
  byId("update-cancel").addEventListener("click", closeForm);
  byId("update-title").addEventListener("input", updateSubmitState);
  byId("update-submit").addEventListener("click", submitForm);
  byId("update-form").addEventListener("submit", e => {
    e.preventDefault();
    submitForm();
  });
  // Ctrl/Cmd+Enter в тексте — сохранить запись.
  byId("update-text").addEventListener("keydown", e => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); submitForm(); }
  });
}