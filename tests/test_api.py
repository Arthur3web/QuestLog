"""Тесты API: задачи, перенос, срок выполнения и удаление колонок."""

import io

import pytest


def make_task(client, board_id, column_id, **fields):
    payload = {"board_id": board_id, "column_id": column_id, "title": "Задача"}
    payload.update(fields)
    return client.post("/api/tasks", json=payload)


def tasks_in(client, board_id, column_id):
    """Задачи колонки в порядке отображения (запрос идёт по position)."""
    state = client.get(f"/api/state?board_id={board_id}").get_json()
    column = next(c for c in state["columns"] if c["id"] == column_id)
    return column["tasks"]


def column_ids(client, board_id, column_id):
    return [t["id"] for t in tasks_in(client, board_id, column_id)]


def positions(client, board_id, column_id):
    return [t["position"] for t in tasks_in(client, board_id, column_id)]


def upload(client, task_id, filename, data):
    return client.post(
        f"/api/tasks/{task_id}/attachments",
        data={"file": (io.BytesIO(data), filename)},
        content_type="multipart/form-data",
    )


# ------------------------------------------------------------
# Создание задачи
# ------------------------------------------------------------
def test_create_task_returns_task(client, board):
    board_id, cols = board
    res = make_task(
        client, board_id, cols["Бэклог"],
        title="Купить хлеб", tags=["Дом", "Срочно"], priority="high",
    )
    assert res.status_code == 201
    task = res.get_json()
    assert task["title"] == "Купить хлеб"
    assert task["tags"] == ["Дом", "Срочно"]
    assert task["priority"] == "high"
    assert task["position"] == 0
    assert task["column_id"] == cols["Бэклог"]


def test_create_task_requires_title(client, board):
    board_id, cols = board
    assert make_task(client, board_id, cols["Бэклог"], title="   ").status_code == 400
    assert client.post(
        "/api/tasks", json={"board_id": board_id, "column_id": cols["Бэклог"]}
    ).status_code == 400


def test_create_task_rejects_column_of_another_board(client, board):
    board_id, _ = board
    other_board = client.post("/api/boards", json={"name": "Другая"}).get_json()
    other_column = client.get(f"/api/state?board_id={other_board['id']}").get_json()["columns"][0]
    res = make_task(client, board_id, other_column["id"])
    assert res.status_code == 400
    assert "Колонка" in res.get_json()["error"]


@pytest.mark.parametrize("bad_due", ["2025-02-31", "2025-13-01", "2025-00-10", "вчера", "abc"])
def test_create_task_rejects_bad_due_date(client, board, bad_due):
    board_id, cols = board
    res = make_task(client, board_id, cols["Бэклог"], due_date=bad_due)
    assert res.status_code == 400
    assert "дата" in res.get_json()["error"]
    # Мусорную дату в базу не пишем: задач не появилось.
    assert tasks_in(client, board_id, cols["Бэклог"]) == []


def test_create_task_without_due_date(client, board):
    board_id, cols = board
    res = make_task(client, board_id, cols["Бэклог"])
    assert res.status_code == 201
    assert res.get_json()["due_date"] == ""


def test_create_task_with_due_date(client, board):
    board_id, cols = board
    res = make_task(client, board_id, cols["Бэклог"], due_date="2026-01-15")
    assert res.status_code == 201
    assert res.get_json()["due_date"] == "2026-01-15"


# ------------------------------------------------------------
# Изменение срока
# ------------------------------------------------------------
def test_update_task_accepts_due_date(client, board):
    board_id, cols = board
    task = make_task(client, board_id, cols["Бэклог"]).get_json()
    res = client.put(f"/api/tasks/{task['id']}", json={"due_date": "2026-03-01"})
    assert res.status_code == 200
    assert client.get(f"/api/tasks/{task['id']}").get_json()["due_date"] == "2026-03-01"


def test_update_task_rejects_bad_due_date(client, board):
    board_id, cols = board
    task = make_task(client, board_id, cols["Бэклог"]).get_json()
    res = client.put(f"/api/tasks/{task['id']}", json={"due_date": "2025-02-31"})
    assert res.status_code == 400
    assert "дата" in res.get_json()["error"]
    # Прежний срок не затёрт неудачной попыткой.
    assert client.get(f"/api/tasks/{task['id']}").get_json()["due_date"] == ""


# ------------------------------------------------------------
# Перенос между колонками и досками
# ------------------------------------------------------------
def test_move_task_reindexes_both_columns(client, board):
    board_id, cols = board
    backlog, todo = cols["Бэклог"], cols["Todo"]
    first = make_task(client, board_id, backlog, title="Первая").get_json()
    second = make_task(client, board_id, backlog, title="Вторая").get_json()
    in_todo = make_task(client, board_id, todo, title="Уже в Todo").get_json()

    res = client.post(f"/api/tasks/{first['id']}/move", json={"column_id": todo, "position": 0})
    assert res.status_code == 200

    assert column_ids(client, board_id, todo) == [first["id"], in_todo["id"]]
    assert positions(client, board_id, todo) == [0, 1]
    # В исходной колонке не осталось «дыры» в порядке.
    assert column_ids(client, board_id, backlog) == [second["id"]]
    assert positions(client, board_id, backlog) == [0]


def test_move_task_to_another_board(client, board):
    board_id, cols = board
    task = make_task(client, board_id, cols["Бэклог"]).get_json()
    new_board = client.post("/api/boards", json={"name": "Вторая доска"}).get_json()
    target = client.get(f"/api/state?board_id={new_board['id']}").get_json()["columns"][0]

    res = client.post(f"/api/tasks/{task['id']}/move", json={"column_id": target["id"], "position": 0})
    assert res.status_code == 200

    fresh = client.get(f"/api/tasks/{task['id']}").get_json()
    assert fresh["board_id"] == new_board["id"]
    assert fresh["column_id"] == target["id"]
    assert tasks_in(client, board_id, cols["Бэклог"]) == []


def test_move_task_into_missing_column(client, board):
    board_id, cols = board
    task = make_task(client, board_id, cols["Бэклог"]).get_json()
    res = client.post(f"/api/tasks/{task['id']}/move", json={"column_id": 9999, "position": 0})
    assert res.status_code == 404


# ------------------------------------------------------------
# Удаление колонок
# ------------------------------------------------------------
def test_delete_column_with_tasks_is_forbidden(client, board):
    board_id, cols = board
    make_task(client, board_id, cols["Бэклог"])
    res = client.delete(f"/api/columns/{cols['Бэклог']}")
    assert res.status_code == 400
    assert "Нельзя удалить" in res.get_json()["error"]
    state = client.get(f"/api/state?board_id={board_id}").get_json()
    assert cols["Бэклог"] in [c["id"] for c in state["columns"]]


def test_delete_empty_column(client, board):
    board_id, _ = board
    new_column = client.post(
        "/api/columns", json={"board_id": board_id, "name": "На удаление"}
    ).get_json()
    assert client.delete(f"/api/columns/{new_column['id']}").status_code == 200
    state = client.get(f"/api/state?board_id={board_id}").get_json()
    assert "На удаление" not in [c["name"] for c in state["columns"]]


# ------------------------------------------------------------
# Вложения
# ------------------------------------------------------------
def test_attachment_upload_and_download(client, board):
    board_id, cols = board
    task = make_task(client, board_id, cols["Бэклог"]).get_json()
    content = "привет".encode("utf-8")

    res = upload(client, task["id"], "заметка.txt", content)
    assert res.status_code == 201
    attachment = res.get_json()
    assert attachment["filename"] == "заметка.txt"
    assert attachment["size_bytes"] == len(content)

    download = client.get(f"/api/attachments/{attachment['id']}/download")
    assert download.status_code == 200
    assert download.data == content
    assert download.headers["Content-Disposition"].startswith("attachment")


def test_attachment_upload_rejects_missing_file(client, board):
    board_id, cols = board
    task = make_task(client, board_id, cols["Бэклог"]).get_json()
    res = client.post(
        f"/api/tasks/{task['id']}/attachments", data={}, content_type="multipart/form-data"
    )
    assert res.status_code == 400


def test_inline_preview_allowed_for_pdf(client, board):
    """PDF можно встраивать во фрейм: именно так работает превью в лайтбоксе."""
    board_id, cols = board
    task = make_task(client, board_id, cols["Бэклог"]).get_json()
    attachment = upload(client, task["id"], "документ.pdf", b"%PDF-1.4\n%%EOF\n").get_json()

    res = client.get(f"/api/attachments/{attachment['id']}/download?inline=1")
    assert res.status_code == 200
    assert res.headers["Content-Disposition"].startswith("inline")
    assert res.headers["Content-Type"].startswith("application/pdf")


@pytest.mark.parametrize("filename", ["страница.html", "картинка.svg", "заметка.txt"])
def test_inline_preview_refused_for_other_types(client, board, filename):
    """HTML и SVG не встраиваем: в контексте приложения они выполнили бы скрипт."""
    board_id, cols = board
    task = make_task(client, board_id, cols["Бэклог"]).get_json()
    attachment = upload(client, task["id"], filename, b"<b>test</b>").get_json()

    res = client.get(f"/api/attachments/{attachment['id']}/download?inline=1")
    assert res.status_code == 200
    assert res.headers["Content-Disposition"].startswith("attachment")


def test_update_comment_text(client, board):
    """Текст комментария можно отредактировать."""
    board_id, cols = board
    task = make_task(client, board_id, cols["Бэклог"]).get_json()
    created = client.post(f"/api/tasks/{task['id']}/comments", json={"user_id": 1, "text": "Первый вариант"})
    comment = created.get_json()

    res = client.put(f"/api/comments/{comment['id']}", json={"text": "Исправленный текст"})
    assert res.status_code == 200
    assert res.get_json()["text"] == "Исправленный текст"

    task_res = client.get(f"/api/tasks/{task['id']}")
    texts = [c["text"] for c in task_res.get_json()["comments"]]
    assert texts == ["Исправленный текст"]


def test_update_comment_rejects_empty_text(client, board):
    """Пустой текст (или одни пробелы) не сохраняется."""
    board_id, cols = board
    task = make_task(client, board_id, cols["Бэклог"]).get_json()
    comment = client.post(f"/api/tasks/{task['id']}/comments", json={"user_id": 1, "text": "Не стирать"}).get_json()

    res = client.put(f"/api/comments/{comment['id']}", json={"text": "   "})
    assert res.status_code == 400

    kept = client.get(f"/api/tasks/{task['id']}").get_json()["comments"][0]["text"]
    assert kept == "Не стирать"


def test_update_comment_404_for_missing(client, board):
    """Чужой/несуществующий id — 404."""
    res = client.put("/api/comments/999999", json={"text": "где-то"})
    assert res.status_code == 404
