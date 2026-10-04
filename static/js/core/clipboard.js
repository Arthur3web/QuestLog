// ==========================================================
// Копирование в буфер обмена.
//
// navigator.clipboard работает только в защищённом контексте
// (https или localhost). В режиме окна приложения и на http без
// localhost его может не быть, поэтому есть запасной путь через
// execCommand — он устарел, но работает везде, где есть документ.
// ==========================================================

export async function copyText(text) {
  if (!text) return false;
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      // Отказал доступ — пробуем запасной путь.
    }
  }
  return copyViaHiddenField(text);
}

function copyViaHiddenField(text) {
  const helper = document.createElement("textarea");
  helper.value = text;
  // Поле уводим за пределы экрана и прячем: иначе страница дёрнется,
  // а в режиме окна поле перехватит фокус и закроет панель по Escape.
  helper.setAttribute("readonly", "readonly");
  helper.style.position = "fixed";
  helper.style.top = "-1000px";
  helper.style.left = "-1000px";
  helper.style.opacity = "0";
  document.body.appendChild(helper);
  helper.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch (e) {
    ok = false;
  }
  document.body.removeChild(helper);
  return ok;
}