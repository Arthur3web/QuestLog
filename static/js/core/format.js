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

// Только время: «10:45»
export function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

// Только дата: «21.09»
export function formatDayMonth(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
}

// Один и тот же календарный день у начала и конца записи?
function sameDay(aIso, bIso) {
  const a = new Date(aIso);
  const b = new Date(bIso);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

// ------------------------------------------------------------
// Интервал записи времени.
//
// Внутри одного дня дата не дублируется: «21.09, 10:45 — 12:50»
// вместо «21.09, 10:45 — 21.09, 12:50». Незакрытая запись —
// «21.09, 10:45 — идёт».
// ------------------------------------------------------------
export function formatTimeRange(startedIso, stoppedIso) {
  if (!stoppedIso) return `${formatDayMonth(startedIso)}, ${formatTime(startedIso)} — идёт`;
  if (sameDay(startedIso, stoppedIso)) {
    return `${formatDayMonth(startedIso)}, ${formatTime(startedIso)} — ${formatTime(stoppedIso)}`;
  }
  return `${formatDateTime(startedIso)} — ${formatDateTime(stoppedIso)}`;
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

// ------------------------------------------------------------
// Длительности (тайм-трекинг)
//
// Нулевые единицы отбрасываются: «2ч 5м» вместо «2ч 5м 0с», а не
// «27ч 0м 0с» — иначе длительность сливается с временем окончания
// в списке записей и читается как часть даты.
// Свыше суток — с днями: «1д 3ч» понятнее, чем «27ч».
// Полный формат: «1д 3ч 2м 5с» / «1ч 2м 3с» / «2м 3с» / «3с»
// ------------------------------------------------------------
export function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;

  const parts = [];
  if (d) parts.push(`${d}д`);
  if (h) parts.push(`${h}ч`);
  if (m) parts.push(`${m}м`);
  // Секунды показываем всегда, если не показано ничего другого:
  // «0с» на записи без длительности честнее пустоты.
  if (sec || !parts.length) parts.push(`${sec}с`);
  return parts.join(" ");
}

// Короткая версия для карточек: «1д 3ч» / «1ч 2м» / «2м» / «3с»
export function formatDurationShort(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return h ? `${d}д ${h}ч` : `${d}д`;
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
