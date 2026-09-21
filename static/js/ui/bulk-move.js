import { API } from "../core/api.js";
import { byId } from "../core/dom.js";
import { showModal, hideModal } from "../core/modal.js";
import { showToast } from "../core/toast.js";
import { TAG_PRESETS } from "../core/config.js";
import { boards, currentBoardId } from "../domain/store.js";
import { loadState } from "../domain/state-loader.js";

let currentBulkTaskId = null;

export function bindBulkMove() {
  const btn = byId("bulk-move-btn");
  if (!btn) return;
  btn.addEventListener("click", openBulkMoveModal);
}

export function openBulkMoveForTask(taskId) {
  currentBulkTaskId = taskId;
  openBulkMoveModal();
}

async function openBulkMoveModal() {
  populateTagSelect();
  populateBoardSelect();
  byId("bm-tag").disabled = !!currentBulkTaskId;
  showModal("bulk-move-modal", () => { currentBulkTaskId = null; });
  byId("bm-execute-btn").onclick = executeBulkMove;
  byId("bm-board").onchange = populateColumnSelect;
}

function populateTagSelect() {
  const sel = byId("bm-tag");
  sel.innerHTML = "";
  if (currentBulkTaskId) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "— одиночная задача —";
    opt.selected = true;
    opt.disabled = true;
    sel.appendChild(opt);
    return;
  }
  TAG_PRESETS.forEach((tag) => {
    const opt = document.createElement("option");
    opt.value = tag;
    opt.textContent = tag;
    sel.appendChild(opt);
  });
  const custom = document.createElement("option");
  custom.value = "__custom__";
  custom.textContent = "Другой…";
  sel.appendChild(custom);
}

async function populateBoardSelect() {
  const sel = byId("bm-board");
  sel.innerHTML = "";
  const list = boards.length ? boards : await API.get("/api/boards");
  list.forEach((b) => {
    const opt = document.createElement("option");
    opt.value = b.id;
    opt.textContent = b.name;
    if (b.id === currentBoardId) opt.selected = true;
    sel.appendChild(opt);
  });
  populateColumnSelect();
}

async function populateColumnSelect() {
  const boardId = Number(byId("bm-board").value);
  const sel = byId("bm-column");
  sel.innerHTML = "";
  if (!boardId) return;
  const autoOpt = document.createElement("option");
  autoOpt.value = "";
  autoOpt.textContent = "— авто (по названию колонки) —";
  sel.appendChild(autoOpt);
  try {
    const state = await API.get(`/api/state?board_id=${boardId}`);
    state.columns.forEach((col) => {
      const opt = document.createElement("option");
      opt.value = col.id;
      opt.textContent = col.name;
      sel.appendChild(opt);
    });
  } catch (e) {
    showToast("Не удалось загрузить колонки доски");
  }
}

async function executeBulkMove() {
  const targetBoardId = Number(byId("bm-board").value);
  const columnSel = byId("bm-column");
  const targetColumnId = columnSel.value ? Number(columnSel.value) : null;

  if (!targetBoardId) {
    showToast("Укажите доску");
    return;
  }

  const payload = {
    source_board_id: currentBoardId,
    target_board_id: targetBoardId,
    target_column_id: targetColumnId,
  };

  if (currentBulkTaskId) {
    payload.task_id = currentBulkTaskId;
  } else {
    const tagSel = byId("bm-tag");
    let tag = tagSel.value;
    if (tag === "__custom__") {
      tag = prompt("Введите тег:");
      if (!tag || !tag.trim()) return;
      tag = tag.trim();
    }
    if (!tag) {
      showToast("Укажите тег");
      return;
    }
    payload.tag = tag;
  }

  try {
    const result = await API.post("/api/tasks/bulk-move", payload);
    if (currentBulkTaskId) {
      showToast(`Задача перенесена (${result.moved})`);
    } else {
      showToast(`Перенесено задач: ${result.moved}`);
    }
    currentBulkTaskId = null;
    hideModal("bulk-move-modal");
    // Обязательно перечитываем состояние с сервера: перенесённые задачи
    // уехали на другую доску и должны исчезнуть с текущей.
    await loadState();
  } catch (e) {
    showToast("Ошибка при переносе задач");
  }
}
