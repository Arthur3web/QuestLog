"""Фикстуры тестов API QuestLog.

Тесты работают на временной базе: server.py держит пути к ней в константах
DB_PATH и ATTACH_DIR, поэтому подменяем их до первого обращения к БД и
заводим схему через init_db(). Данные пользователя в ~/.questlog не
затрагиваются.
"""

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import server  # noqa: E402  — импорт после правки sys.path


@pytest.fixture()
def client(tmp_path, monkeypatch):
    """Flask-клиент на временной базе и временной папке вложений."""
    attach_dir = tmp_path / "attachments"
    attach_dir.mkdir()
    monkeypatch.setattr(server, "DB_PATH", str(tmp_path / "test.db"))
    monkeypatch.setattr(server, "ATTACH_DIR", str(attach_dir))
    server.init_db()
    server.app.config.update(TESTING=True)
    with server.app.test_client() as test_client:
        yield test_client


@pytest.fixture()
def board(client):
    """Первая (засеянная) доска и её колонки по именам."""
    board_id = client.get("/api/boards").get_json()[0]["id"]
    state = client.get(f"/api/state?board_id={board_id}").get_json()
    columns = {column["name"]: column["id"] for column in state["columns"]}
    return board_id, columns
