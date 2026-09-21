// ==========================================================
// Загрузка состояния доски с сервера.
//
// Вынесено в отдельный модуль, чтобы разорвать циклическую
// зависимость board.js <-> task-modal.js: оба модуля могут
// импортировать loadState отсюда без взаимных ссылок.
//
// Здесь же — точка расширения onStateLoaded(): модули, которым
// нужно обновиться после загрузки (например, название доски в
// шапке), регистрируют свой колбэк. Так loadState не импортирует
// их напрямую и не создаёт циклическую зависимость — а цикл здесь
// опасен: он приводит к двум разным копиям store.js и пустому
// списку досок в шапке.
// ==========================================================

import { API } from "../core/api.js";
import {
  state,
  currentBoardId,
  currentUserId,
  setState,
  setCurrentUserId,
} from "./store.js";
import { renderBoard } from "../ui/board.js";
import { renderIdentitySelect } from "../ui/people.js";

const afterLoadCallbacks = [];

// Регистрация того, что нужно вызвать после каждой загрузки состояния.
export function onStateLoaded(fn) {
  afterLoadCallbacks.push(fn);
}

export async function loadState() {
  setState(await API.get(`/api/state?board_id=${currentBoardId}`));
  if (!currentUserId && state.users.length) setCurrentUserId(state.users[0].id);
  renderIdentitySelect();
  afterLoadCallbacks.forEach(fn => fn());
  renderBoard();
}
