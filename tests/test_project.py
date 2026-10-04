"""Тесты проектного слоя доски: описание, обновления, документы, публичная ссылка.

Доска здесь — это проект, поэтому проверяем в том числе, что содержимое
проекта не протекает между досками и что файлы лежат физически в своей папке.
"""

import io
import sqlite3
import zipfile
from pathlib import Path
from urllib.parse import quote

import pytest

import server


def project_of(client, board_id):
    return client.get(f"/api/boards/{board_id}/project").get_json()


def upload_doc(client, board_id, filename, data=b"data"):
    return client.post(
        f"/api/boards/{board_id}/documents",
        data={"file": (io.BytesIO(data), filename)},
        content_type="multipart/form-data",
    )


# ------------------------------------------------------------
# Описание проекта
# ------------------------------------------------------------
def test_description_saved_and_read_back(client, board):
    board_id, _ = board
    assert project_of(client, board_id)["project"]["description"] == ""

    res = client.put(f"/api/boards/{board_id}", json={"description": "Ревизия коробки"})
    assert res.status_code == 200
    assert res.get_json()["description"] == "Ревизия коробки"
    assert project_of(client, board_id)["project"]["description"] == "Ревизия коробки"


def test_description_survives_reload(client, board):
    """Описание лежит в БД, а не в памяти сервера: новый клиент его видит."""
    board_id, _ = board
    client.put(f"/api/boards/{board_id}", json={"description": "Проверка после перезагрузки"})
    with client.application.test_client() as fresh:
        assert project_of(fresh, board_id)["project"]["description"] == "Проверка после перезагрузки"


def test_rename_still_works_and_name_is_untouched_by_description(client, board):
    board_id, _ = board
    client.put(f"/api/boards/{board_id}", json={"description": "Описание"})
    res = client.put(f"/api/boards/{board_id}", json={"name": "Переименованная"})
    assert res.get_json()["name"] == "Переименованная"
    assert res.get_json()["description"] == "Описание"


def test_description_validations(client, board):
    board_id, _ = board
    assert client.put(f"/api/boards/{board_id}", json={"name": "   "}).status_code == 400
    assert client.put(f"/api/boards/{board_id}", json={}).status_code == 400
    too_long = client.put(
        f"/api/boards/{board_id}", json={"description": "я" * (server.MAX_PROJECT_DESC_CHARS + 1)}
    )
    assert too_long.status_code == 400


def test_project_404_for_unknown_board(client):
    assert client.get("/api/boards/999999/project").status_code == 404


# ------------------------------------------------------------
# Обновления проекта
# ------------------------------------------------------------
def test_update_created_with_date_title_and_text(client, board):
    board_id, _ = board
    res = client.post(
        f"/api/boards/{board_id}/updates",
        json={"user_id": 1, "title": "Запустили сборку", "text": "Зелёная", "entry_date": "2026-03-04"},
    )
    assert res.status_code == 201
    update = res.get_json()
    assert update["title"] == "Запустили сборку"
    assert update["text"] == "Зелёная"
    assert update["entry_date"] == "2026-03-04"
    assert project_of(client, board_id)["updates"] == [update]


def test_update_defaults_to_today(client, board):
    import datetime

    board_id, _ = board
    update = client.post(f"/api/boards/{board_id}/updates", json={"title": "Сегодня"}).get_json()
    assert update["entry_date"] == datetime.date.today().isoformat()
    assert update["text"] == ""


def test_updates_are_sorted_newest_first(client, board):
    board_id, _ = board
    for date, title in (("2026-01-01", "Первое"), ("2026-05-01", "Второе"), ("2026-03-01", "Третье")):
        client.post(f"/api/boards/{board_id}/updates", json={"title": title, "entry_date": date})
    titles = [u["title"] for u in project_of(client, board_id)["updates"]]
    assert titles == ["Второе", "Третье", "Первое"]


def test_update_edited_and_deleted(client, board):
    board_id, _ = board
    update = client.post(
        f"/api/boards/{board_id}/updates", json={"title": "Черновик", "text": "было"}
    ).get_json()

    res = client.put(
        f"/api/project-updates/{update['id']}",
        json={"title": "Итог", "text": "стало", "entry_date": "2026-02-02"},
    )
    assert res.status_code == 200
    assert (res.get_json()["title"], res.get_json()["text"]) == ("Итог", "стало")
    assert res.get_json()["entry_date"] == "2026-02-02"

    assert client.delete(f"/api/project-updates/{update['id']}").status_code == 200
    assert project_of(client, board_id)["updates"] == []


def test_update_validations(client, board):
    board_id, _ = board
    assert client.post(f"/api/boards/{board_id}/updates", json={"title": " "}).status_code == 400
    bad_date = client.post(
        f"/api/boards/{board_id}/updates", json={"title": "Ошибка", "entry_date": "2026-02-31"}
    )
    assert bad_date.status_code == 400
    assert project_of(client, board_id)["updates"] == []

    update = client.post(f"/api/boards/{board_id}/updates", json={"title": "Живая"}).get_json()
    assert client.put(f"/api/project-updates/{update['id']}", json={"title": ""}).status_code == 400
    assert client.put("/api/project-updates/999999", json={"title": "нет"}).status_code == 404


def test_updates_do_not_leak_between_boards(client, board):
    board_id, _ = board
    other = client.post("/api/boards", json={"name": "Чужой проект"}).get_json()["id"]
    client.post(f"/api/boards/{board_id}/updates", json={"title": "Только мой"})

    assert project_of(client, other)["updates"] == []
    # Обновление чужой доски нельзя отредактировать через id: чужие id
    # не существуют, а правка всегда идёт по конкретной записи.
    assert client.post("/api/boards/999999/updates", json={"title": "нет"}).status_code == 404


def test_update_author_is_kept_but_survives_user_removal(client, board):
    board_id, _ = board
    author = client.post("/api/users", json={"name": "Редактор"}).get_json()["id"]
    update = client.post(
        f"/api/boards/{board_id}/updates", json={"title": "Правка", "user_id": author}
    ).get_json()
    assert update["user_id"] == author

    client.delete(f"/api/users/{author}")
    assert project_of(client, board_id)["updates"][0]["user_id"] is None


# ------------------------------------------------------------
# Документы проекта
# ------------------------------------------------------------
def test_document_upload_list_and_download(client, board, monkeypatch):
    board_id, _ = board
    content = "Смета проекта".encode("utf-8")
    res = upload_doc(client, board_id, "смета.txt", content)
    assert res.status_code == 201
    doc = res.get_json()
    assert doc["filename"] == "смета.txt"
    assert doc["size_bytes"] == len(content)
    assert doc["preview"] == "text"
    assert doc["mime"] == "text/plain"
    assert doc["created_at"] == doc["updated_at"]

    assert [d["id"] for d in project_of(client, board_id)["documents"]] == [doc["id"]]

    download = client.get(f"/api/project-documents/{doc['id']}/download")
    assert download.status_code == 200
    assert download.data == content
    assert download.headers["Content-Disposition"].startswith("attachment")


@pytest.mark.parametrize(
    "filename, kind",
    [
        ("схема.png", "image"),
        ("схема.jpg", "image"),
        ("инструкция.pdf", "pdf"),
        ("README.md", "text"),
        ("plan.docx", None),
        ("данные.xlsx", None),
    ],
)
def test_preview_kind_matches_app_viewer(client, board, filename, kind):
    """Превью показывается ровно для тех же типов, что и у вложений задачи."""
    board_id, _ = board
    doc = upload_doc(client, board_id, filename).get_json()
    assert doc["preview"] == kind


def test_document_stored_inside_its_board_folder(client, board):
    """Файлы физически привязаны к проекту: отдельная папка на доску."""
    board_id, _ = board
    doc_root = Path(server.DOC_DIR)
    upload_doc(client, board_id, "отчёт.txt")

    board_dir = doc_root / str(board_id)
    assert board_dir.is_dir()
    stored = list(board_dir.iterdir())
    assert len(stored) == 1
    # На диске имя случайное — пользовательское имя живёт только в БД.
    assert stored[0].name != "отчёт.txt"
    assert stored[0].read_bytes() == b"data"


def test_documents_do_not_leak_between_boards(client, board):
    board_id, _ = board
    other = client.post("/api/boards", json={"name": "Другой"}).get_json()["id"]
    mine = upload_doc(client, board_id, "мой.txt").get_json()
    upload_doc(client, other, "чужой.txt")

    assert [d["filename"] for d in project_of(client, board_id)["documents"]] == ["мой.txt"]
    assert [d["filename"] for d in project_of(client, other)["documents"]] == ["чужой.txt"]


def test_document_rename_keeps_extension_and_marks_update(client, board):
    board_id, _ = board
    doc = upload_doc(client, board_id, "черновик.txt").get_json()

    res = client.put(f"/api/project-documents/{doc['id']}", json={"filename": "итог"})
    assert res.status_code == 200
    assert res.get_json()["filename"] == "итог.txt"  # расширение подставлено

    download = client.get(f"/api/project-documents/{doc['id']}/download")
    # Кириллица в заголовке уходит по RFC 5987 — проверяем encoded-имя.
    assert quote("итог.txt") in download.headers["Content-Disposition"]


def test_document_rename_cannot_change_type(client, board):
    """Переименование не должно менять тип: файл-то тот же самый."""
    board_id, _ = board
    doc = upload_doc(client, board_id, "схема.png").get_json()

    # Даже если API-вызов просит другое расширение, остаётся исходное.
    res = client.put(f"/api/project-documents/{doc['id']}", json={"filename": "смета.txt"})
    assert res.get_json()["filename"] == "смета.png"
    assert res.get_json()["preview"] == "image"

    # Расширение всегда возвращается: документ без него стал бы неоткрываемым.
    res = client.put(f"/api/project-documents/{doc['id']}", json={"filename": "схема.2"})
    assert res.get_json()["filename"] == "схема.png"
    assert res.get_json()["preview"] == "image"


def test_document_rename_strips_path(client, board):
    """Имя с путём не должно никуда увести — ни файл, ни архив."""
    board_id, _ = board
    doc = upload_doc(client, board_id, "заметка.txt").get_json()
    res = client.put(f"/api/project-documents/{doc['id']}", json={"filename": "../../секрет.txt"})
    assert res.get_json()["filename"] == "секрет.txt"


def test_document_rename_rejects_taken_name(client, board):
    """Два одинаковых имени в списке читаются как ошибка, а на диске лежат
    два разных файла — переименование должно отказывать."""
    board_id, _ = board
    first = upload_doc(client, board_id, "список.txt").get_json()
    upload_doc(client, board_id, "площадки.txt")

    res = client.put(f"/api/project-documents/{first['id']}", json={"filename": "площадки"})
    assert res.status_code == 409
    # Имя осталось прежним — неудачная попытка ничего не меняет.
    current = client.get(f"/api/boards/{board_id}/project").get_json()["documents"]
    names = sorted(d["filename"] for d in current)
    assert names == ["площадки.txt", "список.txt"]

    # То же имя у себя — не конфликт: переименование вхолостую проходит.
    same = client.put(f"/api/project-documents/{first['id']}", json={"filename": "список"})
    assert same.status_code == 200


def test_document_deleted_from_disk_and_list(client, board):
    board_id, _ = board
    doc = upload_doc(client, board_id, "лишнее.txt").get_json()
    board_dir = Path(server.DOC_DIR) / str(board_id)
    assert [p for p in board_dir.iterdir()]

    assert client.delete(f"/api/project-documents/{doc['id']}").status_code == 200
    assert list(board_dir.iterdir()) == []
    assert project_of(client, board_id)["documents"] == []


def test_board_deletion_removes_documents_row(client, board):
    """Каскад БД: доска удалена — её документы тоже (файлы осиротеют не надолго)."""
    board_id, _ = board
    doc = upload_doc(client, board_id, "doc.txt").get_json()
    with server.app.app_context():
        get_db = server.get_db()
        get_db.execute("DELETE FROM boards WHERE id=?", (board_id,))
        get_db.commit()
        assert get_db.execute(
            "SELECT COUNT(*) c FROM project_documents WHERE board_id=?", (board_id,)
        ).fetchone()["c"] == 0
    assert client.get(f"/api/project-documents/{doc['id']}/download").status_code == 404


def test_document_upload_validations(client, board):
    board_id, _ = board
    assert client.post(
        f"/api/boards/{board_id}/documents", data={}, content_type="multipart/form-data"
    ).status_code == 400
    assert client.post("/api/boards/999999/documents", data={}).status_code == 404
    assert client.put("/api/project-documents/999999", json={"filename": "x"}).status_code == 404


def test_inline_preview_only_for_pdf(client, board):
    """HTML и SVG не встраиваются: на этом же origin они получили бы доступ к API."""
    board_id, _ = board
    pdf = upload_doc(client, board_id, "схема.pdf", b"%PDF-1.4\n%%EOF\n").get_json()
    page = upload_doc(client, board_id, "страница.html", b"<script>alert(1)</script>").get_json()

    inline = client.get(f"/api/project-documents/{pdf['id']}/download?inline=1")
    assert inline.headers["Content-Disposition"].startswith("inline")

    forced = client.get(f"/api/project-documents/{page['id']}/download?inline=1")
    assert forced.status_code == 200
    assert forced.headers["Content-Disposition"].startswith("attachment")


# ------------------------------------------------------------
# Архив документации
# ------------------------------------------------------------
def test_archive_contains_description_updates_and_files(client, board):
    board_id, _ = board
    client.put(f"/api/boards/{board_id}", json={"description": "Цель проекта"})
    client.post(
        f"/api/boards/{board_id}/updates",
        json={"title": "Релиз 1.0", "text": "Выкатили", "entry_date": "2026-04-01"},
    )
    upload_doc(client, board_id, "смета.txt", b"summa")

    res = client.get(f"/api/boards/{board_id}/documents/archive")
    assert res.status_code == 200
    assert res.headers["Content-Type"].startswith("application/zip")
    assert "attachment" in res.headers["Content-Disposition"]

    with zipfile.ZipFile(io.BytesIO(res.data)) as archive:
        names = archive.namelist()
        assert set(names) == {"описание.txt", "обновления.md", "документы/смета.txt"}
        assert archive.read("описание.txt").decode("utf-8") == "Цель проекта"
        changelog = archive.read("обновления.md").decode("utf-8")
        assert "2026-04-01 — Релиз 1.0" in changelog
        assert archive.read("документы/смета.txt") == b"summa"


def test_archive_of_empty_project_is_still_valid(client, board):
    board_id, _ = board
    with zipfile.ZipFile(io.BytesIO(client.get(f"/api/boards/{board_id}/documents/archive").data)) as z:
        assert z.namelist() == ["описание.txt", "обновления.md"]


def test_archive_dedupes_equal_names_and_escapes_paths(client, board):
    board_id, _ = board
    upload_doc(client, board_id, "отчёт.txt", b"first")
    second = upload_doc(client, board_id, "отчёт.txt", b"second").get_json()

    with zipfile.ZipFile(io.BytesIO(client.get(f"/api/boards/{board_id}/documents/archive").data)) as z:
        names = z.namelist()
    assert names.count("документы/отчёт.txt") == 1
    assert len(names) == 4  # описание, обновления и два файла с разными именами

    # Переименование в «путь» не должно вывести файл за пределы архива.
    client.put(f"/api/project-documents/{second['id']}", json={"filename": "../побег.txt"})
    with zipfile.ZipFile(io.BytesIO(client.get(f"/api/boards/{board_id}/documents/archive").data)) as z:
        assert all(not n.startswith("..") and ".." not in n.split("/") for n in z.namelist())


def test_archive_404_for_unknown_board(client):
    assert client.get("/api/boards/999999/documents/archive").status_code == 404


# ------------------------------------------------------------
# Публичный доступ по ссылке
# ------------------------------------------------------------
def test_public_page_hidden_until_switch_is_on(client, board):
    board_id, _ = board
    sharing = client.put(f"/api/boards/{board_id}/sharing", json={"is_public": True})
    assert sharing.status_code == 200
    token = sharing.get_json()["public_token"]
    assert sharing.get_json()["public_path"] == f"/public/docs/{token}"

    assert client.get("/public/docs/неверныйтокен").status_code == 404
    assert client.get("/public/docs/" + token).status_code == 200


def test_public_page_off_returns_404_and_keeps_token(client, board):
    board_id, _ = board
    token = client.put(
        f"/api/boards/{board_id}/sharing", json={"is_public": True}
    ).get_json()["public_token"]

    off = client.put(f"/api/boards/{board_id}/sharing", json={"is_public": False})
    assert off.get_json() == {"docs_public": False, "public_token": None, "public_path": None}
    assert client.get(f"/public/docs/{token}").status_code == 404

    # Токен переживает выключение: ссылка из письма заработает снова.
    on_again = client.put(f"/api/boards/{board_id}/sharing", json={"is_public": True})
    assert on_again.get_json()["public_token"] == token


def test_sharing_validations(client, board):
    board_id, _ = board
    assert client.put(f"/api/boards/{board_id}/sharing", json={}).status_code == 400
    assert client.put("/api/boards/999999/sharing", json={"is_public": True}).status_code == 404


def test_public_page_shows_project_and_escapes_html(client, board):
    board_id, _ = board
    client.put(
        f"/api/boards/{board_id}",
        json={"description": "<script>alert('x')</script>"},
    )
    client.post(
        f"/api/boards/{board_id}/updates", json={"title": "<b>жирный</b>", "text": "<i>курсив</i>"}
    )
    upload_doc(client, board_id, "<img src=x>.txt", b"hi")
    token = client.put(f"/api/boards/{board_id}/sharing", json={"is_public": True}).get_json()["public_token"]

    page = client.get(f"/public/docs/{token}").get_data(as_text=True)
    assert "<script>alert" not in page
    assert "&lt;script&gt;" in page
    assert "&lt;b&gt;жирный&lt;/b&gt;" in page


def test_public_download_only_own_documents(client, board):
    board_id, _ = board
    other = client.post("/api/boards", json={"name": "Чужой"}).get_json()["id"]
    mine = upload_doc(client, board_id, "мой.txt", b"mine").get_json()
    foreign = upload_doc(client, other, "чужой.txt", b"foreign").get_json()
    token = client.put(f"/api/boards/{board_id}/sharing", json={"is_public": True}).get_json()["public_token"]

    ok = client.get(f"/public/docs/{token}/{mine['id']}/download")
    assert ok.status_code == 200
    assert ok.data == b"mine"
    assert ok.headers["Content-Disposition"].startswith("attachment")

    # Документ чужого проекта по нашей ссылке не отдаётся.
    assert client.get(f"/public/docs/{token}/{foreign['id']}/download").status_code == 404


def test_public_download_of_html_is_attachment(client, board):
    """Страница документации отдаётся с тем же origin, поэтому HTML — только вложением."""
    board_id, _ = board
    doc = upload_doc(client, board_id, "страница.html", b"<h1>hi</h1>").get_json()
    token = client.put(f"/api/boards/{board_id}/sharing", json={"is_public": True}).get_json()["public_token"]

    res = client.get(f"/public/docs/{token}/{doc['id']}/download")
    assert res.status_code == 200
    assert res.headers["Content-Disposition"].startswith("attachment")


def test_public_responses_are_not_cached_and_not_sniffed(client, board):
    """Документация по ссылке не должна оседать в кэше и исполняться как скрипт."""
    board_id, _ = board
    doc = upload_doc(client, board_id, "файл.txt", "данные".encode("utf-8")).get_json()
    token = client.put(f"/api/boards/{board_id}/sharing", json={"is_public": True}).get_json()["public_token"]

    for url in (f"/public/docs/{token}", f"/public/docs/{token}/{doc['id']}/download"):
        res = client.get(url)
        assert res.headers["X-Content-Type-Options"] == "nosniff"
        assert res.headers["Cache-Control"] == "no-store"


def test_app_responses_are_not_patched(client, board):
    """Заголовки безопасности добавляются только публичным ответам."""
    res = client.get("/api/health")
    assert "X-Content-Type-Options" not in res.headers


# ------------------------------------------------------------
# Лента событий
# ------------------------------------------------------------
def events_of(client, board_id):
    return client.get(f"/api/boards/{board_id}/events").get_json()


def test_event_written_with_author_from_header(client, board):
    """Кто сделал — берётся из заголовка, который шлёт фронтенд."""
    board_id, cols = board
    res = client.post(
        f"/api/tasks",
        json={"board_id": board_id, "column_id": cols["Бэклог"], "title": "Собрать смету"},
        headers={"X-QuestLog-User": "1"},
    )
    assert res.status_code == 201

    events = events_of(client, board_id)
    assert events, "событие о создании задачи должно появиться"
    latest = events[0]
    assert latest["kind"] == "task_created"
    assert "Собрать смету" in latest["text"]
    assert latest["user_id"] == 1


def test_event_without_author_stays_anonymous(client, board):
    board_id, cols = board
    client.post(
        f"/api/tasks",
        json={"board_id": board_id, "column_id": cols["Бэклог"], "title": "Без автора"},
    )
    latest = events_of(client, board_id)[0]
    assert latest["user_id"] is None


def test_task_lifecycle_events(client, board):
    board_id, cols = board
    task = client.post(
        f"/api/tasks",
        json={"board_id": board_id, "column_id": cols["Бэклог"], "title": "Жизненный цикл"},
    ).get_json()

    client.put(f"/api/tasks/{task['id']}", json={"priority": "high"})
    client.post(f"/api/tasks/{task['id']}/move", json={"column_id": cols["Todo"], "position": 0})
    client.delete(f"/api/tasks/{task['id']}")

    kinds = [e["kind"] for e in events_of(client, board_id)]
    assert kinds[:4] == ["task_deleted", "task_moved", "task_updated", "task_created"]
    moved = next(e for e in events_of(client, board_id) if e["kind"] == "task_moved")
    assert "Todo" in moved["text"]
    updated = next(e for e in events_of(client, board_id) if e["kind"] == "task_updated")
    # Название поля переводится, а не показывается ключом.
    assert "приоритет" in updated["text"]
    # Форма шлёт себя целиком, но в ленте остаются только изменённые поля.
    assert "название" not in updated["text"]
    assert "теги" not in updated["text"]


def test_task_update_event_lists_only_real_changes(client, board):
    board_id, cols = board
    task = client.post(
        f"/api/tasks",
        json={"board_id": board_id, "column_id": cols["Бэклог"], "title": "Смета"},
    ).get_json()

    # Форма задачи присылает все поля без изменений — события быть не должно.
    client.put(f"/api/tasks/{task['id']}", json={
        "title": "Смета", "description": "", "priority": "normal",
        "due_date": "", "assignee_id": None, "tags": [],
    })
    assert not [e for e in events_of(client, board_id) if e["kind"] == "task_updated"]

    client.put(f"/api/tasks/{task['id']}", json={
        "title": "Смета", "description": "", "priority": "normal",
        "due_date": "", "assignee_id": None, "tags": ["Работа"],
    })
    updated = [e for e in events_of(client, board_id) if e["kind"] == "task_updated"]
    assert len(updated) == 1
    assert "теги" in updated[0]["text"]
    assert "название" not in updated[0]["text"]


def test_document_and_update_events(client, board):
    board_id, _ = board
    doc = upload_doc(client, board_id, "схема.png").get_json()
    client.put(f"/api/project-documents/{doc['id']}", json={"filename": "схема-2.png"})
    client.delete(f"/api/project-documents/{doc['id']}")

    update = client.post(
        f"/api/boards/{board_id}/updates", json={"title": "Релиз"}
    ).get_json()
    client.delete(f"/api/project-updates/{update['id']}")

    kinds = [e["kind"] for e in events_of(client, board_id)]
    for kind in ("doc_added", "doc_renamed", "doc_deleted", "update_added", "update_deleted"):
        assert kind in kinds, f"нет события {kind}"


def test_project_and_sharing_events(client, board):
    board_id, _ = board
    client.put(f"/api/boards/{board_id}", json={"name": "Переименованный"})
    client.put(f"/api/boards/{board_id}", json={"description": "Описание"})
    client.put(f"/api/boards/{board_id}/sharing", json={"is_public": True})

    texts = [e["text"] for e in events_of(client, board_id)]
    assert any("Переименованный" in t for t in texts)
    assert any("описание" in t.lower() for t in texts)
    assert any("публичной ссылке" in t for t in texts)


def test_events_are_newest_first_and_bounded(client, board):
    board_id, cols = board
    for i in range(5):
        client.post(
            f"/api/tasks",
            json={"board_id": board_id, "column_id": cols["Бэклог"], "title": f"Задача {i}"},
        )
    events = events_of(client, board_id)
    assert [e["id"] for e in events] == sorted((e["id"] for e in events), reverse=True)

    limited = client.get(f"/api/boards/{board_id}/events?limit=2").get_json()
    assert len(limited) == 2


def test_events_do_not_leak_between_boards(client, board):
    board_id, cols = board
    other = client.post("/api/boards", json={"name": "Чужой"}).get_json()["id"]
    client.post(
        f"/api/tasks",
        json={"board_id": board_id, "column_id": cols["Бэклог"], "title": "Только мой"},
    )
    assert events_of(client, other) == []
    assert client.get("/api/boards/999999/events").status_code == 404


def test_event_author_survives_user_removal(client, board):
    board_id, cols = board
    author = client.post("/api/users", json={"name": "Автор"}).get_json()["id"]
    client.post(
        f"/api/tasks",
        json={"board_id": board_id, "column_id": cols["Бэклог"], "title": "Задача"},
        headers={"X-QuestLog-User": str(author)},
    )
    client.delete(f"/api/users/{author}")
    assert events_of(client, board_id)[0]["user_id"] is None


# ------------------------------------------------------------
# Досье проекта (отчёт)
# ------------------------------------------------------------
def test_report_counts_tasks_columns_and_time(client, board):
    board_id, cols = board
    for title in ("Первая", "Вторая"):
        task = client.post(
            f"/api/tasks",
            json={"board_id": board_id, "column_id": cols["Бэклог"], "title": title},
        ).get_json()
        client.post(f"/api/tasks/{task['id']}/timer/start", json={"user_id": 1})
        client.post(f"/api/tasks/{task['id']}/timer/stop")

    report = client.get(f"/api/boards/{board_id}/report").get_json()
    assert report["totals"]["tasks"] == 2
    assert report["totals"]["done"] == 0
    backlog = next(c for c in report["by_column"] if c["name"] == "Бэклог")
    assert backlog["total"] == 2
    assert report["by_assignee"][0]["tasks"] == 2
    assert report["project"]["name"]


def test_report_counts_done_by_done_columns(client, board):
    board_id, cols = board
    task = client.post(
        f"/api/tasks",
        json={"board_id": board_id, "column_id": cols["Бэклог"], "title": "Сделана"},
    ).get_json()
    client.post(f"/api/tasks/{task['id']}/move", json={"column_id": cols["Done"], "position": 0})

    report = client.get(f"/api/boards/{board_id}/report").get_json()
    assert report["totals"]["done"] == 1
    assert report["totals"]["active"] == 0
    done = next(c for c in report["by_column"] if c["name"] == "Done")
    assert done["done"] is True and done["total"] == 1


def test_report_groups_tags_and_priorities(client, board):
    board_id, cols = board
    for title, priority, tags in (
        ("A", "high", ["Баг", "Работа"]),
        ("B", "high", ["Баг"]),
        ("C", "low", []),
    ):
        client.post(
            f"/api/tasks",
            json={
                "board_id": board_id, "column_id": cols["Бэклог"],
                "title": title, "priority": priority, "tags": tags,
            },
        )
    report = client.get(f"/api/boards/{board_id}/report").get_json()
    assert report["by_priority"]["high"] == 2
    assert report["by_priority"]["low"] == 1
    assert report["top_tags"][0] == {"tag": "Баг", "count": 2}


def test_report_includes_description_updates_and_documents(client, board):
    board_id, _ = board
    client.put(f"/api/boards/{board_id}", json={"description": "Цель"})
    client.post(f"/api/boards/{board_id}/updates", json={"title": "Релиз 1.0"})
    upload_doc(client, board_id, "смета.txt", b"summa")

    report = client.get(f"/api/boards/{board_id}/report").get_json()
    assert report["totals"]["updates"] == 1
    assert report["totals"]["documents"] == 1
    assert report["totals"]["documents_size"] == 5
    assert report["documents"][0]["filename"] == "смета.txt"


def test_report_html_renders_and_escapes(client, board):
    board_id, cols = board
    client.put(
        f"/api/boards/{board_id}",
        json={"name": "<b>Проект</b>", "description": "<script>alert(1)</script>"},
    )
    client.post(f"/api/boards/{board_id}/updates", json={"title": "<i>Релиз</i>"})
    client.post(
        f"/api/tasks",
        json={"board_id": board_id, "column_id": cols["Бэклог"], "title": "Задача", "tags": ["Баг"]},
    )

    res = client.get(f"/api/boards/{board_id}/report.html")
    assert res.status_code == 200
    page = res.get_data(as_text=True)
    assert "<script>alert" not in page
    assert "&lt;b&gt;Проект&lt;/b&gt;" in page
    assert "&lt;i&gt;Релиз&lt;/i&gt;" in page
    # Ключевые блоки отчёта на месте.
    for marker in ("Описание", "Задачи по колонкам", "Люди", "История обновлений", "Документы"):
        assert marker in page


def test_report_html_escapes_task_titles(client, board):
    board_id, cols = board
    client.post(
        f"/api/tasks",
        json={"board_id": board_id, "column_id": cols["Бэклог"], "title": "Ошибка </pre>"},
    )
    page = client.get(f"/api/boards/{board_id}/report.html").get_data(as_text=True)
    # Название задачи в отчёт не попадает, но и не может вырваться разметкой:
    # проверяем, что в тексте страницы нет неэкранированного </pre>.
    assert "</pre><" not in page


def test_report_404_for_unknown_board(client):
    assert client.get("/api/boards/999999/report").status_code == 404
    assert client.get("/api/boards/999999/report.html").status_code == 404


# ------------------------------------------------------------
# Миграция существующей базы
# ------------------------------------------------------------
def test_existing_database_gets_project_columns(tmp_path, monkeypatch):
    """База прошлой версии (без новых колонок и таблиц) обновляется на старте."""
    db_path = tmp_path / "old.db"
    conn = sqlite3.connect(db_path)
    conn.executescript(
        """
        CREATE TABLE boards (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE columns (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
            name TEXT NOT NULL, position INTEGER NOT NULL, is_done_state INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id INTEGER, column_id INTEGER,
            title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', priority TEXT NOT NULL DEFAULT 'normal',
            assignee_id INTEGER, tags TEXT NOT NULL DEFAULT '', due_date TEXT NOT NULL DEFAULT '',
            position INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
            color TEXT NOT NULL DEFAULT '#6E56CF', created_at TEXT NOT NULL);
        CREATE TABLE comments (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER, user_id INTEGER,
            text TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE attachments (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER,
            filename TEXT NOT NULL, stored_name TEXT NOT NULL, size_bytes INTEGER NOT NULL,
            uploaded_at TEXT NOT NULL);
        CREATE TABLE subtasks (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER,
            title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL,
            created_at TEXT NOT NULL);
        CREATE TABLE time_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER, user_id INTEGER,
            description TEXT NOT NULL DEFAULT '', started_at TEXT NOT NULL, stopped_at TEXT,
            duration_seconds INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
        INSERT INTO boards (name, created_at) VALUES ('Старая доска', '2020-01-01T00:00:00');
        INSERT INTO columns (board_id, name, position) VALUES (1, 'Бэклог', 0);
        INSERT INTO tasks (board_id, column_id, title, position, created_at, updated_at)
            VALUES (1, 1, 'Старая задача', 0, '2020-01-01T00:00:00', '2020-01-01T00:00:00');
        """
    )
    conn.commit()
    conn.close()

    monkeypatch.setattr(server, "DB_PATH", str(db_path))
    server.init_db()  # повторный запуск на существующей базе

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    board = conn.execute("SELECT * FROM boards WHERE id=1").fetchone()
    assert board["name"] == "Старая доска"
    assert board["description"] == ""
    assert board["docs_public"] == 0
    assert board["public_token"] is None
    assert conn.execute("SELECT COUNT(*) c FROM tasks").fetchone()["c"] == 1
    tables = {
        r["name"] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }
    assert {"project_updates", "project_documents"} <= tables
    conn.close()

    # И обновление по старой доске работает: id остался прежним.
    server.app.config.update(TESTING=True)
    with server.app.test_client() as migrated:
        assert migrated.get("/api/boards/1/project").get_json()["project"]["name"] == "Старая доска"

# ------------------------------------------------------------
# Досье на выход и пересказ
# ------------------------------------------------------------
def test_dossier_is_selfcontained_zip(client, board):
    """Архив читается без приложения: страница со встроенными стилями + тексты."""
    board_id, _ = board
    client.put(f"/api/boards/{board_id}", json={"description": "Описание проекта"})
    client.post(f"/api/boards/{board_id}/updates", json={"title": "Релиз"})
    upload_doc(client, board_id, "схема.txt", b"schema")

    res = client.get(f"/api/boards/{board_id}/dossier")
    assert res.status_code == 200
    assert "zip" in res.headers["Content-Type"]

    with zipfile.ZipFile(io.BytesIO(res.data)) as archive:
        names = set(archive.namelist())
        assert {"досье.html", "обновления.md", "события.md"} <= names
        assert "документы/схема.txt" in names
        page = archive.read("досье.html").decode("utf-8")
        # Стили внутри страницы: без них отчёт на чужом компьютере будет пустым.
        assert "<style>" in page
        assert 'href="/static/style.css"' not in page
        assert "Описание проекта" in page
        assert "Релиз" in archive.read("обновления.md").decode("utf-8")
        events_md = archive.read("события.md").decode("utf-8")
        assert events_md.startswith("## ")
        assert "Обновление «Релиз»" in events_md


def test_dossier_names_follow_board_name(client, board):
    board_id, _ = board
    res = client.get(f"/api/boards/{board_id}/dossier")
    # Имя файла неlatin-ное, поэтому браузеру уходит filename* в UTF-8.
    disposition = res.headers["Content-Disposition"]
    assert disposition.endswith(".zip")
    assert "filename*=UTF-8''" in disposition


def test_dossier_unknown_board_is_404(client):
    assert client.get("/api/boards/9999/dossier").status_code == 404


def test_digest_summarises_recent_changes(client, board):
    """Пересказ отвечает на «что изменилось», а не «что случилось»."""
    board_id, cols = board
    assert project_of(client, board_id)["digest"] == ""
    with zipfile.ZipFile(io.BytesIO(client.get(f"/api/boards/{board_id}/dossier").data)) as archive:
        assert "Событий пока нет" in archive.read("события.md").decode("utf-8")

    client.post(
        f"/api/tasks",
        json={"board_id": board_id, "column_id": cols["Todo"], "title": "Сверстать сетку"},
    )
    client.post(f"/api/boards/{board_id}/updates", json={"title": "Готово"})
    upload_doc(client, board_id, "протокол.txt")

    digest = project_of(client, board_id)["digest"]
    assert digest.startswith("С ")
    assert digest.endswith(".")
    assert "1 задача" in digest
    assert "1 обновление" in digest
    assert "1 документ" in digest


def test_digest_uses_russian_plural_forms():
    assert server._plural_count(1, "задача", "задачи", "задач") == "1 задача"
    assert server._plural_count(2, "задача", "задачи", "задач") == "2 задачи"
    assert server._plural_count(5, "задача", "задачи", "задач") == "5 задач"
    assert server._plural_count(11, "задача", "задачи", "задач") == "11 задач"
    assert server._plural_count(21, "задача", "задачи", "задач") == "21 задача"


# ------------------------------------------------------------
# Зависшие задачи и текстовый список для письма
# ------------------------------------------------------------
def make_task(client, board_id, column_id, title, **fields):
    return client.post(
        f"/api/tasks",
        json={"board_id": board_id, "column_id": column_id, "title": title, **fields},
    ).get_json()


def test_report_lists_stuck_tasks(client, board):
    """Зависшая — не завершённая и с одной из трёх причин."""
    board_id, cols = board
    client.post(f"/api/boards/{board_id}/updates", json={"title": "Релиз"})

    someone = client.post("/api/users", json={"name": "Исполнитель"}).get_json()["id"]

    make_task(client, board_id, cols["Todo"], "Без исполнителя")
    make_task(
        client, board_id, cols["Todo"], "Просроченная",
        due_date="2020-01-01", assignee_id=someone,
    )
    # Есть исполнитель, нет срока, правка свежая — зависания нет.
    make_task(client, board_id, cols["Todo"], "Живая", assignee_id=someone)
    # Срок в будущем, но исполнителя нет — это тоже причина.
    make_task(client, board_id, cols["Todo"], "Будущая", due_date="2999-01-01")

    stuck = client.get(f"/api/boards/{board_id}/report").get_json()["stuck"]
    titles = [t["title"] for t in stuck]
    assert "Без исполнителя" in titles
    assert "Просроченная" in titles
    assert "Живая" not in titles, "задача без исполнителя, но созданная только что, не зависла"
    assert "Будущая" in titles, "без исполнителя — тоже причина"

    reasons = {t["title"]: t["reasons"] for t in stuck}
    assert reasons["Без исполнителя"] == ["без исполнителя"]
    assert "срок прошёл" in reasons["Просроченная"]
    assert reasons["Просроченная"] == ["срок прошёл"]
    stuck_with_owner = [t for t in stuck if t["title"] == "Просроченная"]
    assert stuck_with_owner[0]["assignee"] == "Исполнитель"


def test_stuck_excludes_done_and_counts_stale(client, board):
    board_id, cols = board
    done = make_task(client, board_id, cols["Todo"], "Закрытая", assignee_id=None)
    client.post(f"/api/tasks/{done['id']}/move", json={"column_id": cols["Done"], "position": 0})
    make_task(client, board_id, cols["Todo"], "Свежая", assignee_id=None)

    # Отматываем время задачи назад — теперь она «без движения».
    conn = sqlite3.connect(server.DB_PATH)
    old = "2000-01-01T00:00:00"
    conn.execute("UPDATE tasks SET updated_at=? WHERE id=(SELECT MAX(id) FROM tasks)", (old,))
    conn.commit()
    conn.close()

    titles = [t["title"] for t in client.get(f"/api/boards/{board_id}/report").get_json()["stuck"]]
    assert "Закрытая" not in titles, "задача в завершающей колонке зависшей быть не может"
    assert "Свежая" in titles


def test_dossier_contains_plain_task_list(client, board):
    """Текстовый файл нужен, чтобы вставить список в письмо без HTML."""
    board_id, cols = board
    someone = client.post("/api/users", json={"name": "Мария"}).get_json()["id"]
    make_task(
        client, board_id, cols["Todo"], "Сверстать сетку",
        assignee_id=someone, due_date="2026-11-01", priority="high",
    )
    make_task(client, board_id, cols["Done"], "Отправить заявку")

    with zipfile.ZipFile(io.BytesIO(client.get(f"/api/boards/{board_id}/dossier").data)) as archive:
        assert "задачи.txt" in archive.namelist()
        text = archive.read("задачи.txt").decode("utf-8")

    assert "Todo" in text and "Сверстать сетку" in text
    assert "Отправить заявку" in text
    # У задачи с исполнителем печатается его имя, срок и срочность.
    assert "Мария" in text
    assert "до 01.11" in text
    assert "срочно" in text
    assert "без исполнителя" in text, "у задачи без исполнителя это написано явно"
    assert "<" not in text and ">" not in text, "это обычный текст, а не разметка"


def test_plain_task_list_marks_missing_assignee(client, board):
    board_id, cols = board
    make_task(client, board_id, cols["Todo"], "Без исполнителя")
    with zipfile.ZipFile(io.BytesIO(client.get(f"/api/boards/{board_id}/dossier").data)) as archive:
        text = archive.read("задачи.txt").decode("utf-8")
    assert "без исполнителя" in text


# ------------------------------------------------------------
# Создание и правка текстовых документов
# ------------------------------------------------------------
def create_text_doc(client, board_id, filename="протокол.md", text=""):
    return client.post(
        f"/api/boards/{board_id}/documents/text",
        json={"filename": filename, "text": text},
    )


def test_create_text_document_writes_real_file(client, board):
    board_id, _ = board
    res = create_text_doc(client, board_id, "протокол.md", "Площадки согласованы.\n")
    assert res.status_code == 201
    doc = res.get_json()
    assert doc["filename"] == "протокол.md"
    assert doc["preview"] == "text"

    # На диске лежит настоящий файл в папке доски, а не запись в базе.
    stored = list(Path(server.DOC_DIR).glob(f"{board_id}/*"))
    assert len(stored) == 1
    assert stored[0].read_text(encoding="utf-8") == "Площадки согласованы.\n"
    assert stored[0].name == Path(doc["filename"]).name or stored[0].suffix == ".md"


def test_create_text_document_gets_markdown_extension(client, board):
    """Без расширения просмотрщик не поймёт тип — подставляем .md."""
    board_id, _ = board
    res = create_text_doc(client, board_id, "заметка")
    assert res.get_json()["filename"] == "заметка.md"


def test_create_text_document_rejects_binary_and_duplicates(client, board):
    board_id, _ = board
    # Формат в задаче не спрашивается: не текстовое расширение заменяется,
    # а не отвергается всё имя.
    assert create_text_doc(client, board_id, "схема.png").get_json()["filename"] == "схема.md"
    assert create_text_doc(client, board_id, "  ").status_code == 400

    assert create_text_doc(client, board_id, "протокол.md").status_code == 201
    assert create_text_doc(client, board_id, "протокол.md").status_code == 409


def test_read_and_write_document_content(client, board):
    board_id, _ = board
    doc = create_text_doc(client, board_id, "заметка.md", "черновик").get_json()

    content = client.get(f"/api/project-documents/{doc['id']}/content").get_json()
    assert content["text"] == "черновик"
    assert content["stamp"]

    res = client.put(
        f"/api/project-documents/{doc['id']}/content",
        json={"text": "готово", "stamp": content["stamp"]},
    )
    assert res.status_code == 200
    assert res.get_json()["size_bytes"] > 0

    again = client.get(f"/api/project-documents/{doc['id']}/content").get_json()
    assert again["text"] == "готово"


def test_write_document_rejects_stale_stamp(client, board):
    """Файл поменяли мимо приложения — затирать чужую правку нельзя."""
    board_id, _ = board
    doc = create_text_doc(client, board_id, "заметка.md", "черновик").get_json()
    stale = client.get(f"/api/project-documents/{doc['id']}/content").get_json()["stamp"]

    # Правка мимо приложения: время и размер файла меняются.
    import time
    time.sleep(1.1)
    path = Path(server.DOC_DIR) / str(board_id)
    stored = next(path.iterdir())
    stored.write_text("правка снаружи", encoding="utf-8")

    res = client.put(
        f"/api/project-documents/{doc['id']}/content",
        json={"text": "из приложения", "stamp": stale},
    )
    assert res.status_code == 409
    assert stored.read_text(encoding="utf-8") == "правка снаружи", "файл перезаписан"


def test_content_endpoints_refuse_non_text(client, board):
    board_id, _ = board
    doc = upload_doc(client, board_id, "схема.png", b"\x89PNG").get_json()
    assert client.get(f"/api/project-documents/{doc['id']}/content").status_code == 404
    assert client.put(
        f"/api/project-documents/{doc['id']}/content", json={"text": "x"}
    ).status_code == 404


def test_editing_document_writes_event(client, board):
    board_id, _ = board
    doc = create_text_doc(client, board_id, "заметка.md", "черновик").get_json()
    stamp = client.get(f"/api/project-documents/{doc['id']}/content").get_json()["stamp"]
    client.put(f"/api/project-documents/{doc['id']}/content", json={"text": "готово", "stamp": stamp})
    kinds = [e["kind"] for e in events_of(client, board_id)]
    assert "doc_added" in kinds
    assert "doc_edited" in kinds
