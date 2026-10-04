// ==========================================================
// Палитра команд (Ctrl+K).
//
// Одно поле, в котором ищутся действия приложения: доски,
// разделы панели проекта, запуск палитры, темы. Команды
// собираются из живого состояния, поэтому новые доски
// появляются в списке сами.
//
// Замысел: не добавлять кнопки, а дать быстрый доступ ко всему
// редкому. Поэтому здесь только то, чем пользуются часто,
// но через которое иначе пришлось бы кликать по меню.
// ==========================================================

import { byId, escapeHtml } from "../core/dom.js";
import { ICONS } from "../core/icons.js";
import { boards, currentBoardId, setOnlyMine, onlyMine } from "../domain/store.js";
import { showModal, hideModal, isModalOpen } from "../core/modal.js";
import { showToast } from "../core/toast.js";
import { openProjectDrawer } from "./project-drawer.js";
import { openNewTaskModal } from "./task-modal.js";
import { renderBoard } from "./board.js";
import { switchBoard } from "./boards.js";
import { applyTheme, availableThemes, currentTheme } from "./theme.js";

// Команды: заголовок, подсказка (что делает), иконка, обработчик.
// hint подставляется в строку поиска вместе с заголовком.
let commands = [];
let filtered = [];
let cursor = 0;

// Названия тем для палитры — те же, что в списке в подвале.
const THEME_LABELS = { retro: "Ретро", poster: "Плакат" };

// ------------------------------------------------------------
// Сбор списка команд
// ------------------------------------------------------------
function buildCommands() {
  const list = [];

  list.push({
    id: "new-task",
    title: "Новая задача",
    hint: "открыть форму создания",
    icon: "subtasks",
    run: () => openNewTaskModal(),
  });

  list.push({
    id: "project-overview",
    title: "Проект: обзор",
    hint: "описание и доступ",
    icon: "panel",
    run: () => openProjectDrawer("overview"),
  });
  list.push({
    id: "project-updates",
    title: "Проект: обновления",
    hint: "история изменений",
    icon: "panel",
    run: () => openProjectDrawer("updates"),
  });
  list.push({
    id: "project-events",
    title: "Проект: события",
    hint: "кто что менял",
    icon: "panel",
    run: () => openProjectDrawer("events"),
  });
  list.push({
    id: "project-docs",
    title: "Проект: документы",
    hint: "файлы и архив",
    icon: "attachment",
    run: () => openProjectDrawer("docs"),
  });

  boards.forEach((board) => {
    list.push({
      id: `board-${board.id}`,
      title: board.name,
      hint: board.id === currentBoardId ? "доска уже открыта" : "перейти на доску",
      icon: "boards",
      current: board.id === currentBoardId,
      run: () => switchBoard(board.id),
    });
  });

  list.push({
    id: "toggle-mine",
    title: onlyMine ? "Показать все задачи" : "Показать только мои задачи",
    hint: "фильтр «Мои задачи» (Alt+M)",
    icon: "eye",
    run: () => {
      setOnlyMine(!onlyMine);
      byId("my-tasks-btn").classList.toggle("toggle-active", onlyMine);
      renderBoard();
    },
  });

  availableThemes().forEach((theme) => {
    const current = currentTheme() === theme;
    list.push({
      id: `theme-${theme}`,
      title: `Тема: ${THEME_LABELS[theme] || theme}`,
      hint: current ? "уже применена" : "переключить оформление",
      icon: "theme",
      current,
      run: () => applyTheme(theme),
    });
  });

  return list;
}

// ------------------------------------------------------------
// Поиск
// ------------------------------------------------------------
// Подсветка совпадения в заголовке: помогает понять, что именно нашлось.
function highlight(title, query) {
  if (!query) return escapeHtml(title);
  const at = title.toLowerCase().indexOf(query.toLowerCase());
  if (at === -1) return escapeHtml(title);
  const cut = (s) => escapeHtml(s);
  return `${cut(title.slice(0, at))}<mark>${cut(title.slice(at, at + query.length))}</mark>${cut(title.slice(at + query.length))}`;
}

function applyFilter(query) {
  const needle = query.trim().toLowerCase();
  filtered = !needle
    ? commands
    : commands.filter((c) =>
      `${c.title} ${c.hint}`.toLowerCase().includes(needle),
    );
  cursor = 0;
  render();
}

function render() {
  const list = byId("palette-list");
  const query = byId("palette-input").value;
  list.innerHTML = "";

  if (!filtered.length) {
    list.innerHTML = `<li class="palette-empty">Ничего не найдено: «${escapeHtml(query.trim())}»</li>`;
    updateHint();
    return;
  }

  filtered.forEach((command, index) => {
    const item = document.createElement("li");
    item.className = "palette-item" + (index === cursor ? " active" : "");
    item.dataset.paletteIndex = String(index);
    item.innerHTML = `
      <span class="palette-icon">${ICONS[command.icon] || ICONS.chevronRight}</span>
      <span class="palette-text">
        <span class="palette-title">${highlight(command.title, query)}</span>
        <span class="palette-hint">${escapeHtml(command.hint)}</span>
      </span>
      ${command.current ? '<span class="palette-current">сейчас</span>' : ""}
    `;
    item.addEventListener("mouseenter", () => {
      cursor = index;
      syncCursor();
    });
    item.addEventListener("click", () => runCommand(command));
    list.appendChild(item);
  });
  updateHint();
}

// Подсветка активной строки меняется и с клавиатуры, и мышью —
// поэтому список не перерисовывается целиком.
function syncCursor() {
  byId("palette-list")
    .querySelectorAll(".palette-item")
    .forEach((item, index) => {
      item.classList.toggle("active", index === cursor);
    });
  updateHint();
}

function updateHint() {
  const hint = byId("palette-hint");
  if (!hint) return;
  const command = filtered[cursor];
  hint.textContent = command
    ? `${cursor + 1} из ${filtered.length} · Enter — выполнить`
    : "↑↓ — выбрать, Enter — выполнить, Esc — закрыть";
}

// ------------------------------------------------------------
// Выполнение
// ------------------------------------------------------------
function runCommand(command) {
  closePalette();
  if (!command) return;
  try {
    command.run();
  } catch (e) {
    showToast("Не удалось выполнить команду");
  }
}

function moveCursor(step) {
  if (!filtered.length) return;
  cursor = (cursor + step + filtered.length) % filtered.length;
  syncCursor();
  const active = byId("palette-list").querySelector(".palette-item.active");
  if (active) active.scrollIntoView({ block: "nearest" });
}

// ------------------------------------------------------------
// Открытие и закрытие
// ------------------------------------------------------------
let paletteOpen = false;

export function isPaletteOpen() {
  return paletteOpen;
}

export function openPalette() {
  commands = buildCommands();
  paletteOpen = true;
  const input = byId("palette-input");
  input.value = "";
  applyFilter("");
  showModal("palette-modal");
  setTimeout(() => input.focus(), 30);
}

export function closePalette() {
  if (!paletteOpen) return;
  paletteOpen = false;
  hideModal("palette-modal");
}

function togglePalette() {
  if (paletteOpen) closePalette();
  else openPalette();
}

// ------------------------------------------------------------
// Привязка (один раз на старте)
// ------------------------------------------------------------
export function bindCommandPalette() {
  byId("palette-input").addEventListener("input", (e) => applyFilter(e.target.value));

  byId("palette-modal").addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); moveCursor(1); }
    if (e.key === "ArrowUp") { e.preventDefault(); moveCursor(-1); }
    if (e.key === "Home" && filtered.length) { e.preventDefault(); cursor = 0; syncCursor(); }
    if (e.key === "End" && filtered.length) {
      e.preventDefault();
      cursor = filtered.length - 1;
      syncCursor();
    }
    if (e.key === "Enter") {
      e.preventDefault();
      runCommand(filtered[cursor]);
    }
  });

  // Ctrl+K / Cmd+K — стандартная комбинация для палитры команд.
  document.addEventListener("keydown", (e) => {
    const isK = e.key === "k" || e.key === "K" || e.key === "к" || e.key === "К";
    if (!((e.ctrlKey || e.metaKey) && isK)) return;
    // Над открытой модалкой палитра не нужна: сначала закройте её.
    if (isModalOpen() && !paletteOpen) return;
    e.preventDefault();
    togglePalette();
  });
}