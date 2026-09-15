// ==========================================================
// Мелкие DOM-помощники, используемые всеми view-модулями.
// ==========================================================

// Короткий доступ к document.getElementById
export function byId(id) {
  return document.getElementById(id);
}

// Безопасная вставка текста в HTML-шаблоны
export function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}

// Первые две буквы имени — для аватара
export function initials(name) {
  return name.trim().slice(0, 2).toUpperCase();
}

// Делегирование: один обработчик на контейнер вместо N на строки.
// Дочерний элемент ищется по селектору вверх от e.target.
export function delegate(container, selector, eventName, handler) {
  container.addEventListener(eventName, (e) => {
    const target = e.target.closest(selector);
    if (target && container.contains(target)) handler(e, target);
  });
}
