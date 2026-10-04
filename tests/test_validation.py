"""Тесты веток валидации API: 400 на плохой ввод, 404 на отсутствующие сущности.

Дополняют test_api.py (счастливые пути) именно ошибочными ветками —
теми, что раньше не покрывались: rename досок/колонок, bulk-move,
редактирование задач/комментариев/подзадач/записей времени, таймеры,
пользователи, вложения (файл не передан, пустое имя, inline-превью).
"""

import io

import pytest


def make_task(client, board_id, column_id, **fields):
    payload = {"board_id": board_id, "column_id": column_id, "title": "Задача"}
    payload.update(fields)
    return client.post("/api/tasks", json=payload)


def upload(client, task_id, filename, data=b"content"):
    return client.post(
        f"/api/tasks/{task_id}/attachments",
        data={"file": (io.BytesIO(data), filename)},
        content_type="multipart/form-data",
    )


def create_board(client, name):
    return client.post("/api/boards", json={"name": name})


def task_id_from(client, board_id, column_id, title="Задача"):
    return make_task(client, board_id, column_id, title=title).get_json()["id"]


# ------------------------------------------------------------
# Доски: создание и переименование
# ------------------------------------------------------------
def test_create_board_requires_name(client):
    assert client.post("/api/boards", json={"name": "   "}).status_code == 400


def test_rename_board_roundtrip(client, board):
    board_id, _ = board
    res = client.put(f"/api/boards/{board_id}", json={"name": "Новое имя"})
    assert res.status_code == 200
    # Ответ — карточка проекта целиком (в т.ч. описание и настройка
    # публичного доступа), поэтому сверяем нужные поля, а не весь dict.
    project = res.get_json()
    assert project["id"] == board_id
    assert project["name"] == "Новое имя"
    assert project["description"] == ""
    assert project["docs_public"] is False


def test_rename_board_validations(client, board):
    board_id, _ = board
    assert client.put(f"/api/boards/{board_id}", json={"name": "  "}).status_code == 400
    res = client.put("/api/boards/999999", json={"name": "Чего-то"})
    assert res.status_code == 404


# ------------------------------------------------------------
# Колонки
# ------------------------------------------------------------
def test_create_column_validations(client, board):
    board_id, _ = board
    assert client.post("/api/columns", json={"name": "X"}).status_code == 400
    assert client.post("/api/columns", json={"board_id": board_id}).status_code == 400
    res = client.post("/api/columns", json={"board_id": board_id, "name": "QA"})
    assert res.status_code == 201
    assert res.get_json()["name"] == "QA"


def test_rename_column(client, board):
    board_id, cols = board
    assert client.put(f"/api/columns/{cols['Todo']}", json={"name": "  "}).status_code == 400
    res = client.put(f"/api/columns/{cols['Todo']}", json={"name": "В работе"})
    assert res.status_code == 200
    names = [c["name"] for c in client.get(f"/api/state?board_id={board_id}").get_json()["columns"]]
    assert "В работе" in names


def test_delete_empty_column_ok_and_with_tasks_blocked(client, board):
    board_id, cols = board
    make_task(client, board_id, cols["Бэклог"])
    assert client.delete(f"/api/columns/{cols['Бэклог']}").status_code == 400

    res = client.post("/api/columns", json={"board_id": board_id, "name": "Пустая"})
    assert client.delete(f"/api/columns/{res.get_json()['id']}").get_json() == {"ok": True}


# ------------------------------------------------------------
# Задачи: валидации создания и обновления
# ------------------------------------------------------------
def test_create_task_missing_fields(client, board):
    board_id, cols = board
    assert client.post("/api/tasks", json={"title": "X"}).status_code == 400
    assert client.post(
        "/api/tasks", json={"column_id": cols["Todo"], "title": "X"}
    ).status_code == 400


def test_create_task_invalid_due_date(client, board):
    board_id, cols = board
    res = make_task(client, board_id, cols["Todo"], due_date="2025-02-31")
    assert res.status_code == 400
    assert "дата" in res.get_json()["error"]


def test_create_task_column_from_other_board(client, board):
    board_id, cols = board
    other = create_board(client, "Другая").get_json()["id"]
    assert make_task(client, board_id, cols["Todo"]).status_code == 201
    # колонка из другой доски не принимает задачу «чужой» доски
    state = client.get(f"/api/state?board_id={other}").get_json()
    foreign_col = state["columns"][0]["id"]
    assert make_task(client, board_id, foreign_col).status_code == 400


def test_update_task_validations(client, board):
    board_id, cols = board
    tid = task_id_from(client, board_id, cols["Todo"])

    assert client.put(f"/api/tasks/{tid}", json={"title": "   "}).status_code == 400
    res = client.put(f"/api/tasks/{tid}", json={"priority": "сверхвысокий"})
    assert res.status_code == 400 and "приоритет" in res.get_json()["error"]
    res = client.put(f"/api/tasks/{tid}", json={"due_date": "31.12.2026"})
    assert res.status_code == 400 and "дата" in res.get_json()["error"]


def test_update_task_tags_and_assignee_roundtrip(client, board):
    board_id, cols = board
    tid = task_id_from(client, board_id, cols["Todo"])
    res = client.put(
        f"/api/tasks/{tid}",
        json={"tags": ["  Работа ", "", "Срочно"], "assignee_id": None},
    )
    assert res.status_code == 200
    body = res.get_json()
    assert body["tags"] == ["Работа", "Срочно"]


def test_get_and_delete_missing_task(client):
    assert client.get("/api/tasks/999999").status_code == 404
    # удаление отсутствующей задачи идемпотентно (200 {ok:true}) — фиксируем контракт
    assert client.delete("/api/tasks/999999").get_json() == {"ok": True}


def test_delete_task_removes_attachment_files(client, board, monkeypatch):
    board_id, cols = board
    tid = task_id_from(client, board_id, cols["Todo"])
    upload(client, tid, "report.pdf", b"%PDF-1.4")
    # имя на диске генерирует сервер — узнаём его через БД до удаления
    import sqlite3
    import server

    db = sqlite3.connect(server.DB_PATH)
    stored = db.execute("SELECT stored_name FROM attachments").fetchone()[0]
    db.close()

    assert client.delete(f"/api/tasks/{tid}").get_json() == {"ok": True}
    from pathlib import Path

    assert not (Path(server.ATTACH_DIR) / stored).exists()
    # сама запись вложения ушла вместе с задачей: скачивание больше не работает
    assert client.get("/api/attachments/1/download").status_code == 404


def test_move_task_missing_entities(client, board):
    board_id, cols = board
    tid = task_id_from(client, board_id, cols["Todo"])
    assert client.post(f"/api/tasks/{tid}/move", json={"column_id": cols["Todo"]}).get_json() == {"ok": True}
    assert client.post("/api/tasks/999999/move", json={"column_id": 1}).status_code == 404
    res = client.post(f"/api/tasks/{tid}/move", json={"column_id": 999999})
    assert res.status_code == 404


# ------------------------------------------------------------
# Массовый перенос (bulk-move) — валидации и оба режима
# ------------------------------------------------------------
def test_bulk_move_validations(client, board):
    board_id, cols = board
    assert client.post("/api/tasks/bulk-move", json={}).status_code == 400
    assert client.post(
        "/api/tasks/bulk-move", json={"source_board_id": board_id, "target_board_id": board_id}
    ).status_code == 400
    assert client.post(
        "/api/tasks/bulk-move",
        json={"tag": "Работа", "source_board_id": board_id, "target_board_id": 999999},
    ).status_code == 404
    assert client.post(
        "/api/tasks/bulk-move",
        json={"tag": "Работа", "source_board_id": 999999, "target_board_id": board_id},
    ).status_code == 404
    assert client.post(
        "/api/tasks/bulk-move",
        json={
            "tag": "Работа", "source_board_id": board_id, "target_board_id": board_id,
            "target_column_id": 999999,
        },
    ).status_code == 404


def test_bulk_move_by_tag_maps_columns_by_name(client, board):
    board_id, cols = board
    target = create_board(client, "Архив").get_json()["id"]
    make_task(client, board_id, cols["Todo"], title="А", tags=["Работа"])
    make_task(client, board_id, cols["Todo"], title="Б", tags=["Личное"])

    res = client.post(
        "/api/tasks/bulk-move",
        json={"tag": "Работа", "source_board_id": board_id, "target_board_id": target},
    )
    assert res.status_code == 200
    assert res.get_json()["moved"] == 1

    state = client.get(f"/api/state?board_id={target}").get_json()
    todo = next(c for c in state["columns"] if c["name"] == "Todo")
    assert [t["title"] for t in todo["tasks"]] == ["А"]


def test_bulk_move_single_task_to_explicit_column(client, board):
    board_id, cols = board
    target = create_board(client, "Два").get_json()["id"]
    target_state = client.get(f"/api/state?board_id={target}").get_json()
    target_done = next(c for c in target_state["columns"] if c["name"] == "Done")

    tid = task_id_from(client, board_id, cols["Todo"], title="Одна")
    res = client.post(
        "/api/tasks/bulk-move",
        json={
            "task_id": tid, "source_board_id": board_id, "target_board_id": target,
            "target_column_id": target_done["id"],
        },
    )
    assert res.get_json()["moved"] == 1
    state = client.get(f"/api/state?board_id={target}").get_json()
    done = next(c for c in state["columns"] if c["id"] == target_done["id"])
    assert [t["title"] for t in done["tasks"]] == ["Одна"]


# ------------------------------------------------------------
# Комментарии
# ------------------------------------------------------------
def test_comment_validations_and_crud(client, board):
    board_id, cols = board
    tid = task_id_from(client, board_id, cols["Todo"])

    assert client.post(f"/api/tasks/{tid}/comments", json={"text": "  "}).status_code == 400
    assert client.post("/api/tasks/999999/comments", json={"text": "X"}).status_code == 404

    created = client.post(
        f"/api/tasks/{tid}/comments", json={"text": "Привет", "user_id": 1}
    )
    assert created.status_code == 201
    cid = created.get_json()["id"]

    assert client.put(f"/api/comments/{cid}", json={"text": ""}).status_code == 400
    assert client.put("/api/comments/999999", json={"text": "Y"}).status_code == 404

    updated = client.put(f"/api/comments/{cid}", json={"text": "Пока"})
    assert updated.get_json()["text"] == "Пока"
    assert client.delete(f"/api/comments/{cid}").get_json() == {"ok": True}


# ------------------------------------------------------------
# Вложения: ошибки загрузки и inline-превью
# ------------------------------------------------------------
def test_attachment_upload_validations(client, board):
    board_id, cols = board
    tid = task_id_from(client, board_id, cols["Todo"])

    assert client.post(f"/api/tasks/{tid}/attachments").status_code == 400
    assert upload(client, tid, "").status_code == 400
    assert client.post("/api/tasks/999999/attachments", data={"file": (io.BytesIO(b"x"), "f.txt")},
                       content_type="multipart/form-data").status_code == 404


def test_attachment_inline_preview_pdf_but_not_html(client, board):
    board_id, cols = board
    tid = task_id_from(client, board_id, cols["Todo"])

    pdf = upload(client, tid, "doc.pdf", b"%PDF-1.4 fake").get_json()
    html = upload(client, tid, "page.html", b"<script>alert(1)</script>").get_json()

    inline = client.get(f"/api/attachments/{pdf['id']}/download?inline=1")
    assert "inline" in inline.headers.get("Content-Disposition", "")

    forced = client.get(f"/api/attachments/{html['id']}/download?inline=1")
    assert "attachment" in forced.headers.get("Content-Disposition", "")

    assert client.get("/api/attachments/999999/download").status_code == 404


def test_delete_attachment_removes_file(client, board):
    board_id, cols = board
    tid = task_id_from(client, board_id, cols["Todo"])
    att_id = upload(client, tid, "a.txt", b"hello").get_json()["id"]

    assert client.delete(f"/api/attachments/{att_id}").get_json() == {"ok": True}
    from pathlib import Path
    import server

    remaining = list(Path(server.ATTACH_DIR).glob("*"))
    assert remaining == [], "файл вложения должен быть удалён с диска"


# ------------------------------------------------------------
# Подзадачи
# ------------------------------------------------------------
def test_subtask_validations_and_crud(client, board):
    board_id, cols = board
    tid = task_id_from(client, board_id, cols["Todo"])

    assert client.post(f"/api/tasks/{tid}/subtasks", json={"title": " "}).status_code == 400
    assert client.post("/api/tasks/999999/subtasks", json={"title": "X"}).status_code == 404

    sub = client.post(f"/api/tasks/{tid}/subtasks", json={"title": "Шаг 1"})
    assert sub.status_code == 201
    sid = sub.get_json()["id"]

    assert client.put(f"/api/subtasks/{sid}", json={"title": ""}).status_code == 400
    assert client.put("/api/subtasks/999999", json={"done": True}).status_code == 404

    assert client.put(f"/api/subtasks/{sid}", json={"done": True}).get_json()["done"] is True
    renamed = client.put(f"/api/subtasks/{sid}", json={"title": "Шаг 1 (поправлен)"})
    assert renamed.get_json()["title"] == "Шаг 1 (поправлен)"
    assert client.delete(f"/api/subtasks/{sid}").get_json() == {"ok": True}


# ------------------------------------------------------------
# Таймеры и записи времени
# ------------------------------------------------------------
def test_timer_start_stop_and_single_running_per_user(client, board):
    board_id, cols = board
    t1 = task_id_from(client, board_id, cols["Todo"], title="Первая")
    t2 = task_id_from(client, board_id, cols["Todo"], title="Вторая")

    assert client.post("/api/tasks/999999/timer/start", json={"user_id": 1}).status_code == 404

    assert client.post(f"/api/tasks/{t1}/timer/start", json={"user_id": 1}).status_code == 201
    # второй таймер того же пользователя останавливает первый
    assert client.post(f"/api/tasks/{t2}/timer/start", json={"user_id": 1}).status_code == 201

    detail1 = client.get(f"/api/tasks/{t1}").get_json()
    assert detail1["timer_running"] is False  # первый таймер остановлен вторым

    stopped = client.post(f"/api/tasks/{t2}/timer/stop")
    assert stopped.status_code == 200
    assert stopped.get_json()["duration_seconds"] >= 0

    assert client.post(f"/api/tasks/{t2}/timer/stop").status_code == 404


def test_time_entry_update_and_delete(client, board):
    board_id, cols = board
    tid = task_id_from(client, board_id, cols["Todo"])
    client.post(f"/api/tasks/{tid}/timer/start", json={"user_id": 1})
    entry = client.post(f"/api/tasks/{tid}/timer/stop").get_json()

    res = client.put(
        f"/api/time-entries/{entry['id']}",
        json={
            "description": "Правка руками", "duration_seconds": -5,
            "started_at": entry["started_at"], "stopped_at": entry["stopped_at"],
        },
    )
    assert res.status_code == 200
    body = res.get_json()
    assert body["description"] == "Правка руками"
    assert body["duration_seconds"] == 0  # отрицательная длительность зажата в 0

    assert client.put("/api/time-entries/999999", json={}).status_code == 404
    assert client.delete(f"/api/time-entries/{entry['id']}").get_json() == {"ok": True}


# ------------------------------------------------------------
# Пользователи
# ------------------------------------------------------------
def test_list_users_returns_created(client):
    client.post("/api/users", json={"name": "Аня"})
    client.post("/api/users", json={"name": "Борис", "color": "#123456"})
    users = client.get("/api/users").get_json()
    names = [u["name"] for u in users]
    # список отсортирован по id и содержит обоих созданных (сид-пользователь «Я» может быть раньше)
    assert names[-2:] == ["Аня", "Борис"]
    assert users[-1]["color"] == "#123456"


def test_user_validations_and_delete_nulls_assignee(client, board):
    assert client.post("/api/users", json={"name": " "}).status_code == 400

    created = client.post("/api/users", json={"name": "Аня"})
    assert created.status_code == 201
    uid = created.get_json()["id"]

    board_id, cols = board
    tid = task_id_from(client, board_id, cols["Todo"])
    client.put(f"/api/tasks/{tid}", json={"assignee_id": uid})

    assert client.delete(f"/api/users/{uid}").get_json() == {"ok": True}
    assert client.get(f"/api/tasks/{tid}").get_json()["assignee_id"] is None


# ------------------------------------------------------------
# Инфраструктурные маршруты
# ------------------------------------------------------------
def test_health_index_and_static(client):
    assert client.get("/api/health").get_json() == {"ok": True, "app": "QuestLog"}
    assert client.get("/").status_code == 200
    assert client.get("/static/js/ui/main.js").status_code == 200


def test_state_without_board_id_uses_first_board(client):
    state = client.get("/api/state").get_json()
    assert state["board_id"] is not None
    assert state["columns"], "доска по умолчанию должна иметь колонки"
