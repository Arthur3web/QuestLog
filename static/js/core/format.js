// ==========================================================
// Форматирование дат и размеров файлов для интерфейса.
// ==========================================================

export function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
}

export function formatDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

// ------------------------------------------------------------
// Длительности (тайм-трекинг)
// Полный формат: «1ч 2м 3с» / «2м 3с» / «3с»
// ------------------------------------------------------------
export function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}ч ${m}м ${sec}с`;
  if (m) return `${m}м ${sec}с`;
  return `${sec}с`;
}

// Короткая версия для карточек: «1ч 2м» / «2м» / «3с»
export function formatDurationShort(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return m ? `${h}ч ${m}м` : `${h}ч`;
  if (m) return `${m}м`;
  return `${s}с`;
}

// Ключ даты в виде YYYY-MM-DD (совпадает с форматом input[type=date])
export function toDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Разбираем ключ YYYY-MM-DD в локальном времени: new Date('YYYY-MM-DD')
// парсится как UTC и в части часовых поясов сдвигает дату на день.
function parseDateKey(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

// Начало сегодняшнего дня
function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

export function daysUntil(dateKey) {
  if (!dateKey) return null;
  const today = startOfToday();
  return Math.round((parseDateKey(dateKey) - today) / 86400000);
}

// Срок просрочен, если он раньше начала сегодняшнего дня
export function isOverdue(dateKey) {
  const diff = daysUntil(dateKey);
  return diff !== null && diff < 0;
}

// Срок сегодня или в ближайшие N дней (по умолчанию — до завтра включительно)
export function isDueSoon(dateKey, withinDays = 1) {
  const diff = daysUntil(dateKey);
  return diff !== null && diff >= 0 && diff <= withinDays;
}
