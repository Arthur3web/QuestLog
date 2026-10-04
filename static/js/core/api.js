// ==========================================================
// Тонкая обёртка над fetch. Все запросы к backend идут через
// неё, поэтому точку логирования/обработки ошибок можно
// добавить в одном месте.
// ==========================================================

// Кто сейчас работает в приложении. Ставится из main.js при старте
// и при смене участника, и подставляется в каждый изменяющий запрос:
// сервер записывает это в ленту событий проекта.
let actorId = null;

export function setActorId(id) {
  actorId = id || null;
}

function actorHeaders() {
  return actorId ? { "X-QuestLog-User": String(actorId) } : {};
}

async function json(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return res.json();
}

export const API = {
  get(url) {
    return json(url);
  },
  post(url, body) {
    return json(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...actorHeaders() },
      body: JSON.stringify(body || {}),
    });
  },
  put(url, body) {
    return json(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...actorHeaders() },
      body: JSON.stringify(body || {}),
    });
  },
  del(url) {
    return json(url, { method: "DELETE", headers: actorHeaders() });
  },
  // Загрузка файла идёт через FormData, поэтому Content-Type
  // НЕ выставляем — браузер подставит boundary сам.
  upload(url, formData) {
    return fetch(url, { method: "POST", headers: actorHeaders(), body: formData });
  },
};
