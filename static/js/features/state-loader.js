// ==========================================================
// Загрузка состояния доски с сервера.
//
// Вынесено в отдельный модуль, чтобы разорвать циклическую
// зависимость board.js <-> task-modal.js: оба модуля могут
// импортировать loadState отсюда без взаимных ссылок.
// ==========================================================

import { API } from "../core/api.js";
import {
  state,
  currentBoardId,
  currentUserId,
  setState,
  setCurrentUserId,
} from "../core/store.js";
import { renderBoard } from "./board.js";
import { renderIdentitySelect } from "./people.js";

export async function loadState() {
  setState(await API.get(`/api/state?board_id=${currentBoardId}`));
  if (!currentUserId && state.users.length) setCurrentUserId(state.users[0].id);
  renderIdentitySelect();
  renderBoard();
}
