// ==========================================================
// Тонкая обёртка над fetch. Все запросы к backend идут через
// неё, поэтому точку логирования/обработки ошибок можно
// добавить в одном месте.
// ==========================================================

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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
  },
  put(url, body) {
    return json(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
  },
  del(url) {
    return json(url, { method: "DELETE" });
  },
  // Загрузка файла идёт через FormData, поэтому Content-Type
  // НЕ выставляем — браузер подставит boundary сам.
  upload(url, formData) {
    return fetch(url, { method: "POST", body: formData });
  },
};
