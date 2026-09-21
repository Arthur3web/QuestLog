// ==========================================================
// Идентичность («Я:») и управление участниками доски.
// ==========================================================

import { API } from "../core/api.js";
import { byId, escapeHtml, initials } from "../core/dom.js";
import { ICONS } from "../core/icons.js";
import { state, currentUserId, onlyMine, setCurrentUserId } from "../domain/store.js";
import { showModal } from "../core/modal.js";
import { loadState } from "../domain/state-loader.js";
import { renderBoard } from "./board.js";

export function renderIdentitySelect() {
  const sel = byId("current-user-select");
  sel.innerHTML = state.users.map(u => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join("");
  sel.value = currentUserId || (state.users[0] && state.users[0].id) || "";
}

function renderPeopleList() {
  const list = byId("people-list");
  list.innerHTML = "";
  state.users.forEach(u => {
    const row = document.createElement("div");
    row.className = "person-row";
    row.innerHTML = `
      <div class="avatar" style="background:${u.color}">${escapeHtml(initials(u.name))}</div>
      <span class="name">${escapeHtml(u.name)}</span>
      <button class="remove-btn" title="Удалить">${ICONS.close}</button>
    `;
    row.querySelector(".remove-btn").addEventListener("click", async () => {
      const res = await API.del(`/api/users/${u.id}`);
      if (res && res.error) { return; }
      await loadState();
      renderPeopleList();
    });
    list.appendChild(row);
  });
}

function openPeopleModal() {
  renderPeopleList();
  const input = byId("new-person-name");
  input.value = "";
  showModal("people-modal");
  setTimeout(() => input.focus(), 30);
}

async function addPerson() {
  const input = byId("new-person-name");
  const name = input.value.trim();
  if (!name) return;
  await API.post("/api/users", { name });
  input.value = "";
  await loadState();
  renderPeopleList();
  input.focus();
}

export function bindPeople() {
  byId("manage-people-btn").addEventListener("click", openPeopleModal);
  byId("add-person-btn").addEventListener("click", addPerson);
  byId("new-person-name").addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); addPerson(); }
  });

  byId("current-user-select").addEventListener("change", e => {
    setCurrentUserId(Number(e.target.value));
    if (onlyMine) renderBoard();
  });
}

