// ==========================================================
// Панель проекта: описание, обновления и документы доски.
//
// Доска остаётся чистой — здесь просто компактная панель справа,
// как панель календаря, поверх рабочего пространства с колонками.
// Открывается кликом по названию доски в шапке.
//
// Вкладки «Обновления» и «Документы» живут в своих модулях
// (project-updates.js, project-docs.js): здесь — оболочка, загрузка
// данных проекта и вкладка «Обзор».
// ==========================================================

import { API } from "../core/api.js";
import { byId } from "../core/dom.js";
import { showToast } from "../core/toast.js";
import { copyText } from "../core/clipboard.js";
import { isModalOpen } from "../core/modal.js";
import { currentBoardId } from "../domain/store.js";
import { onStateLoaded } from "../domain/state-loader.js";
import { currentBoard, renameBoard } from "./boards.js";
import { availableThemes, currentTheme } from "./theme.js";
import { renderProjectUpdates, bindProjectUpdates } from "./project-updates.js";
import { renderProjectEvents, bindProjectEvents } from "./project-events.js";
import { renderProjectDocs, bindProjectDocs } from "./project-docs.js";

const TABS = ["overview", "updates", "events", "docs"];

let drawerOpen = false;
let activeTab = "overview";
let projectData = null; // {project, updates, documents}

export function isProjectDrawerOpen() {
  return drawerOpen;
}

// ------------------------------------------------------------
// Загрузка данных проекта
// ------------------------------------------------------------
async function loadProject() {
  if (!currentBoardId) return null;
  return API.get(`/api/boards/${currentBoardId}/project`);
}

// Что передаём вкладкам: доску, данные и способ перечитать их после правки.
function paneContext() {
  return { boardId: currentBoardId, data: projectData, reload: renderProject };
}

function setBusy(busy) {
  byId("project-body").setAttribute("aria-busy", busy ? "true" : "false");
  byId("project-load-error").hidden = busy || !projectData;
}

export async function renderProject() {
  if (!drawerOpen || !currentBoardId) return;
  const previous = projectData;
  // При смене доски прошлые данные показывать нельзя — это проект №1,
  // а открыта панель проекта №2.
  const sameBoard = previous && previous.project.id === currentBoardId;
  projectData = sameBoard ? previous : null;
  setBusy(true);

  try {
    projectData = await loadProject();
  } catch (e) {
    setBusy(false);
    byId("project-load-error").hidden = !sameBoard;
    return;
  }
  if (!projectData || !drawerOpen) return;

  renderHeader();
  renderOverview();
  renderActiveTab();
  setBusy(false);
}

// ------------------------------------------------------------
// Обзор: название, описание, публичный доступ
// ------------------------------------------------------------
function renderHeader() {
  const project = projectData.project;
  byId("project-drawer-title").textContent = project.name;
  const counts = [];
  if (projectData.updates.length) counts.push(`обновлений: ${projectData.updates.length}`);
  if (projectData.documents.length) counts.push(`документов: ${projectData.documents.length}`);
  byId("project-drawer-sub").textContent = counts.join(" · ");
}

// Вкладка перерисовывается по общему правилу — и при открытии панели,
// и при переключении, и после перезагрузки содержимого.
function renderActiveTab() {
  if (!projectData) return;
  const ctx = paneContext();
  if (activeTab === "updates") renderProjectUpdates(byId("pane-updates"), ctx);
  if (activeTab === "events") renderProjectEvents(byId("pane-events"), ctx);
  if (activeTab === "docs") renderProjectDocs(byId("pane-docs"), ctx);
}

// Абсолютный URL строим из адреса приложения: в режиме окна он один,
// в браузере — другой, а путь от сервера одинаковый.
function publicShareUrl(token) {
  return token ? `${window.location.origin}/public/docs/${token}` : "";
}

function showShareLink(token) {
  const field = byId("project-share-url");
  field.dataset.token = token || "";
  field.value = publicShareUrl(token);
}

function renderOverview() {
  const project = projectData.project;

  // Ссылки на досье и на отчёт. Обе — обычные <a>, а не window.open:
  // браузер сам откроет их в новой вкладке, и это работает внутри окна
  // приложения. Тему отчёту передаём явно: страница выбрать её не умеет.
  const theme = availableThemes().includes(currentTheme()) ? currentTheme() : "";
  byId("project-dossier-open").href = `/api/boards/${project.id}/dossier`;
  byId("project-report-open").href =
    `/api/boards/${project.id}/report.html` + (theme ? `?theme=${encodeURIComponent(theme)}` : "");

  const nameInput = byId("project-name");
  if (document.activeElement !== nameInput) nameInput.value = project.name;
  updateNameSaveState();

  const desc = byId("project-desc");
  if (document.activeElement !== desc) desc.value = project.description;
  updateDescSaveState();

  document.querySelectorAll('input[name="project-access"]').forEach((radio) => {
    radio.checked = radio.value === (project.docs_public ? "public" : "private");
  });

  byId("project-share").hidden = !project.docs_public;
  if (project.docs_public && byId("project-share-url").dataset.token !== (project.public_token || "")) {
    showShareLink(project.public_token);
  }
}

function updateNameSaveState() {
  const board = currentBoard();
  const input = byId("project-name");
  const btn = byId("project-name-save");
  if (!board || !input || !btn) return;
  btn.disabled = input.value.trim() === "" || input.value.trim() === board.name;
}

function updateDescSaveState() {
  const desc = byId("project-desc");
  const btn = byId("project-desc-save");
  if (!desc || !btn) return;
  const saved = projectData ? projectData.project.description : "";
  btn.disabled = desc.value === saved;
}

function flashSavedHint(text) {
  const hint = byId("project-desc-hint");
  hint.textContent = text;
  clearTimeout(flashSavedHint.timer);
  flashSavedHint.timer = setTimeout(() => { hint.textContent = ""; }, 2500);
}

async function saveDescription() {
  const desc = byId("project-desc");
  const btn = byId("project-desc-save");
  btn.disabled = true;
  try {
    await API.put(`/api/boards/${currentBoardId}`, { description: desc.value });
    if (projectData) projectData.project.description = desc.value;
    updateDescSaveState();
    flashSavedHint("Сохранено");
  } catch (e) {
    showToast("Не удалось сохранить описание");
    btn.disabled = false;
  }
}

async function applyAccess(isPublic, chosenRadio) {
  const radios = Array.from(document.querySelectorAll('input[name="project-access"]'));
  try {
    const result = await API.put(`/api/boards/${currentBoardId}/sharing`, { is_public: isPublic });
    if (projectData) {
      projectData.project.docs_public = result.docs_public;
      projectData.project.public_token = result.public_token;
    }
    byId("project-share").hidden = !result.docs_public;
    if (result.docs_public) showShareLink(result.public_token);
    showToast(result.docs_public ? "Документация доступна по ссылке" : "Доступ закрыт");
  } catch (e) {
    // Переключатель вернулся не туда — возвращаем как было.
    radios.forEach(r => { r.checked = r === chosenRadio; });
    showToast("Не удалось изменить доступ");
  }
}

async function copyShareLink() {
  const field = byId("project-share-url");
  showToast(await copyText(field.value) ? "Ссылка скопирована" : "Скопируйте ссылку вручную");
}

// ------------------------------------------------------------
// Открытие и закрытие
// ------------------------------------------------------------
function setTab(tab) {
  activeTab = TABS.includes(tab) ? tab : "overview";
  byId("project-tabs").querySelectorAll(".project-tab").forEach((button) => {
    const active = button.dataset.projectTab === activeTab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
    // В дереве вкладок фокусируется только активная — иначе Tab
    // прошёл бы по всем трём подряд.
    button.tabIndex = active ? 0 : -1;
  });
  TABS.forEach(name => {
    byId(`pane-${name}`).hidden = name !== activeTab;
  });
  renderActiveTab();
}

export function openProjectDrawer(tab) {
  if (!currentBoardId) return;
  const wasOpen = drawerOpen;
  drawerOpen = true;
  const overlay = byId("project-overlay");
  overlay.hidden = false;
  requestAnimationFrame(() => overlay.classList.add("open"));
  byId("project-drawer").classList.add("open");
  byId("project-drawer").setAttribute("aria-hidden", "false");
  if (tab) setTab(tab);
  if (!wasOpen) setTab(activeTab);
  renderProject();
}

function toggleProjectDrawer() {
  if (drawerOpen) closeProjectDrawer();
  else openProjectDrawer();
}

export function closeProjectDrawer() {
  if (!drawerOpen) return;
  drawerOpen = false;
  byId("project-drawer").classList.remove("open");
  byId("project-drawer").setAttribute("aria-hidden", "true");
  const overlay = byId("project-overlay");
  overlay.classList.remove("open");
  setTimeout(() => {
    if (!drawerOpen) overlay.hidden = true;
  }, 220);
}

// ------------------------------------------------------------
// Привязка событий (один раз на старте)
// ------------------------------------------------------------
export function bindProjectDrawer() {
  // Название доски в шапке открывает панель проекта. Обработчик здесь,
  // а не в boards.js: так доски не зависят от панели и между модулями
  // не появляется цикл импортов.
  const title = byId("board-title");
  title.addEventListener("click", toggleProjectDrawer);
  // Название — не настоящая кнопка (это <span> ради устойчивой ширины),
  // поэтому Enter и пробел обрабатываем вручную.
  title.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleProjectDrawer();
    }
  });

  byId("project-close").addEventListener("click", closeProjectDrawer);
  byId("project-overlay").addEventListener("click", closeProjectDrawer);
  byId("project-retry").addEventListener("click", renderProject);

  const tabs = byId("project-tabs");
  tabs.addEventListener("click", e => {
    const button = e.target.closest(".project-tab");
    if (button) setTab(button.dataset.projectTab);
  });
  // Полный ARIA-паттерн вкладок: стрелки и Home/End переключают раздел
  // (автоматическая активация — содержимое локальное, грузить нечего).
  tabs.addEventListener("keydown", (e) => {
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(e.key)) return;
    const buttons = Array.from(tabs.querySelectorAll(".project-tab"));
    const current = buttons.indexOf(document.activeElement);
    if (current === -1) return;
    e.preventDefault();
    let next = current;
    if (e.key === "ArrowLeft") next = (current - 1 + buttons.length) % buttons.length;
    if (e.key === "ArrowRight") next = (current + 1) % buttons.length;
    if (e.key === "Home") next = 0;
    if (e.key === "End") next = buttons.length - 1;
    setTab(buttons[next].dataset.projectTab);
    buttons[next].focus();
  });

  // Смена доски при открытой панели: содержимое надо перечитать.
  onStateLoaded(() => {
    if (drawerOpen) renderProject();
  });

  document.addEventListener("keydown", e => {
    // Esc ловим в фазе захвата: обработчик модалок (core/modal.js) стоит
    // раньше и закрывает верхнее окно синхронно. К моменту, когда до нашего
    // обработчика дойдёт всплытие, стек модалок уже пуст — и панель закрылась
    // бы вместе с превью файла. В capture-фазе мы ещё видим исходное
    // состояние и уступаем Escape тому, что лежит поверх.
    if (e.key === "Escape" && drawerOpen && !isModalOpen()) closeProjectDrawer();
  }, true);

  // ---- Обзор ----
  byId("project-name").addEventListener("input", updateNameSaveState);
  byId("project-name").addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); byId("project-name-save").click(); }
  });
  byId("project-name-save").addEventListener("click", async () => {
    try {
      await renameBoard(byId("project-name").value);
      const name = currentBoard() ? currentBoard().name : "";
      if (projectData) projectData.project.name = name;
      byId("project-drawer-title").textContent = name;
      renderHeader();
      updateNameSaveState();
    } catch (e) {
      showToast("Не удалось переименовать проект");
      updateNameSaveState();
    }
  });

  byId("project-desc").addEventListener("input", () => {
    updateDescSaveState();
    byId("project-desc-hint").textContent = "";
  });
  byId("project-desc").addEventListener("keydown", e => {
    // Ctrl/Cmd+Enter — привычное сочетание для сохранения длинного текста.
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); saveDescription(); }
  });
  byId("project-desc-save").addEventListener("click", saveDescription);

  document.querySelectorAll('input[name="project-access"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      if (radio.checked) applyAccess(radio.value === "public", radio);
    });
  });
  byId("project-share-copy").addEventListener("click", copyShareLink);

  bindProjectUpdates();
  bindProjectEvents();
  bindProjectDocs();

  // Ссылка на досье — обычный <a target="_blank">, а не window.open:
  // так она открывается в новой вкладке и внутри desktop-окна, и в браузере.
}