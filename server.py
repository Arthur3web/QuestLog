#!/usr/bin/env python3
"""
QuestLog — локальная платформа управления задачами (в стиле Linear).
Работает одинаково на Windows и Linux: Python + Flask + SQLite, открывается в браузере.

Запуск:
    python server.py
Затем открыть http://127.0.0.1:8420 в браузере.

Все данные хранятся локально в ~/.questlog/taskboard.db
Вложения — в ~/.questlog/attachments/
Документы проектов — в ~/.questlog/documents/<id доски>/

Доска — это проект: у неё есть описание, история обновлений и своё
хранилище документов (см. раздел «Проект: описание, обновления, документы»).
"""
import io
import os
import re
import sqlite3
import uuid
import html
import zipfile
import mimetypes
import datetime
from flask import Flask, request, jsonify, send_from_directory, send_file, g, abort
from flask_cors import CORS

# ============================================================
# Paths & config
# ============================================================
_OLD_APP_DIR = os.path.join(os.path.expanduser("~"), ".taskboard")  # имя папки до переименования проекта в QuestLog
APP_DIR = os.path.join(os.path.expanduser("~"), ".questlog")
DB_PATH = os.path.join(APP_DIR, "taskboard.db")
ATTACH_DIR = os.path.join(APP_DIR, "attachments")
DOC_DIR = os.path.join(APP_DIR, "documents")


def resource_path(*parts):
    """Путь к файлам приложения.

    При сборке в один файл (PyInstaller) исходники распаковываются во
    временную папку, и __file__ указывает именно туда — поэтому сначала
    пробуем sys._MEIPASS, и только потом каталог рядом с модулем.
    """
    import sys
    base = getattr(sys, "_MEIPASS", None) or os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base, *parts)


STATIC_DIR = resource_path("static")


def _static_css():
    """Содержимое style.css — для отчёта, который открывают без сервера."""
    with open(os.path.join(STATIC_DIR, "style.css"), encoding="utf-8") as fh:
        return fh.read()
MAX_UPLOAD_MB = 25
MAX_PROJECT_DESC_CHARS = 5000
# Сколько событий отдаём в панель проекта. Лента растёт безгранично,
# но подгружать её целиком при каждом открытии не нужно.
EVENT_LIMIT = 200

if os.path.isdir(_OLD_APP_DIR) and not os.path.exists(APP_DIR):
    # Одноразовая миграция данных из старой папки ~/.taskboard в ~/.questlog.
    os.rename(_OLD_APP_DIR, APP_DIR)

os.makedirs(APP_DIR, exist_ok=True)
os.makedirs(ATTACH_DIR, exist_ok=True)
os.makedirs(DOC_DIR, exist_ok=True)

app = Flask(__name__, static_folder=None)
CORS(app)
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_MB * 1024 * 1024

DEFAULT_COLUMNS = ["Бэклог", "Todo", "In Progress", "Done", "Cancelled"]
DEFAULT_COLORS = ["#6E56CF", "#E8590C", "#2F9E44", "#1971C2", "#C2255C", "#0CA678"]

# Человеческие названия полей задачи — для ленты событий («изменено:
# приоритет, срок»), чтобы там не торчали английские ключи.
PRIORITY_LABELS = {"high": "Высокий", "medium": "Средний", "normal": "Обычный", "low": "Низкий"}

# Темы оформления приложения: их же принимает страница отчёта через ?theme=.
THEMES = ("retro", "poster")

# Сколько дней без движения считать зависанием.
STUCK_STALE_DAYS = 14

# Предел для документа, который правят в приложении. Совпадает с тем,
# до какого размера просмотрщик вообще тянет текст в браузер.
MAX_TEXT_DOCUMENT_BYTES = 256 * 1024

FIELD_LABELS = {
    "title": "название",
    "description": "описание",
    "priority": "приоритет",
    "due_date": "срок",
    "assignee_id": "исполнитель",
    "tags": "теги",
}


def now_iso():
    return datetime.datetime.now().isoformat(timespec="seconds")


def same_value(old, new):
    """Сравнение значения из колонки с пришедшим из формы: NULL и пустая строка — одно и то же."""
    if old is None:
        old = ""
    if new is None:
        new = ""
    return str(old) == str(new)


def valid_due_date(value):
    value = (value or "").strip()
    if not value:
        return ""
    try:
        datetime.date.fromisoformat(value)
    except ValueError:
        return None
    return value


# ============================================================
# Миграции
# ============================================================
# Схема создаётся через CREATE TABLE IF NOT EXISTS, а новые колонки
# существующих таблиц добавляются через _ensure_column: иначе база,
# созданная прошлой версией, осталась бы без них, а ALTER на каждом
# старте падал бы с «duplicate column name».
def _ensure_column(conn, table, column, ddl):
    existing = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    if column not in existing:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {ddl}")


def migrate_db(conn):
    """Приводит схему к текущему виду: доска становится проектом."""
    _ensure_column(conn, "boards", "description", "description TEXT NOT NULL DEFAULT ''")
    _ensure_column(conn, "boards", "docs_public", "docs_public INTEGER NOT NULL DEFAULT 0")
    _ensure_column(conn, "boards", "public_token", "public_token TEXT")


# ============================================================
# DB helpers
# ============================================================
def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            color TEXT NOT NULL DEFAULT '#6E56CF',
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS boards (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS columns (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            position INTEGER NOT NULL,
            is_done_state INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
            column_id INTEGER NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            priority TEXT NOT NULL DEFAULT 'normal',
            assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            tags TEXT NOT NULL DEFAULT '',
            due_date TEXT NOT NULL DEFAULT '',
            position INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            text TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS attachments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            filename TEXT NOT NULL,
            stored_name TEXT NOT NULL,
            size_bytes INTEGER NOT NULL,
            uploaded_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS subtasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            done INTEGER NOT NULL DEFAULT 0,
            position INTEGER NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS time_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            description TEXT NOT NULL DEFAULT '',
            started_at TEXT NOT NULL,
            stopped_at TEXT,
            duration_seconds INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        );

        -- История обновлений проекта: заголовок, текст и дата записи.
        -- Автор — обычный участник из users, отдельной системы прав
        -- в приложении нет и не появилось.
        CREATE TABLE IF NOT EXISTS project_updates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
            user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            title TEXT NOT NULL,
            text TEXT NOT NULL DEFAULT '',
            entry_date TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        -- Хранилище документов проекта. stored_name — имя файла на диске
        -- (случайное), filename — то, что видит пользователь.
        CREATE TABLE IF NOT EXISTS project_documents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
            filename TEXT NOT NULL,
            stored_name TEXT NOT NULL,
            size_bytes INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_project_updates_board
            ON project_updates(board_id, entry_date);

        -- Лента событий проекта: кто что сделал и когда. Записи делаются
        -- из тех же эндпоинтов, что меняют данные, поэтому история
        -- не может разойтись с самой доской.
        CREATE TABLE IF NOT EXISTS project_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
            user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            kind TEXT NOT NULL,
            text TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_project_documents_board
            ON project_documents(board_id);

        CREATE INDEX IF NOT EXISTS idx_project_events_board
            ON project_events(board_id, id);
        """
    )
    migrate_db(conn)
    conn.commit()

    # Seed default user, board, columns on first run
    cur = conn.execute("SELECT COUNT(*) c FROM users")
    if cur.fetchone()["c"] == 0:
        conn.execute(
            "INSERT INTO users (name, color, created_at) VALUES (?,?,?)",
            ("Я", DEFAULT_COLORS[0], now_iso()),
        )

    cur = conn.execute("SELECT COUNT(*) c FROM boards")
    if cur.fetchone()["c"] == 0:
        cur = conn.execute(
            "INSERT INTO boards (name, created_at) VALUES (?,?)",
            ("Моя доска", now_iso()),
        )
        board_id = cur.lastrowid
        for i, name in enumerate(DEFAULT_COLUMNS):
            conn.execute(
                "INSERT INTO columns (board_id, name, position, is_done_state) VALUES (?,?,?,?)",
                (board_id, name, i, 1 if name in ("Done", "Cancelled") else 0),
            )
    conn.commit()
    conn.close()


# ============================================================
# Serializers
# ============================================================
def user_dict(row):
    return {"id": row["id"], "name": row["name"], "color": row["color"]}


def task_dict(row, comments_count=0, attachments_count=0, subtasks_total=0, subtasks_done=0, time_spent_seconds=0, timer_running=False):
    return {
        "id": row["id"],
        "board_id": row["board_id"],
        "column_id": row["column_id"],
        "title": row["title"],
        "description": row["description"],
        "priority": row["priority"],
        "assignee_id": row["assignee_id"],
        "tags": [t for t in row["tags"].split(",") if t],
        "due_date": row["due_date"],
        "position": row["position"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "comments_count": comments_count,
        "attachments_count": attachments_count,
        "subtasks_total": subtasks_total,
        "subtasks_done": subtasks_done,
        "time_spent_seconds": time_spent_seconds,
        "timer_running": timer_running,
    }


def subtask_dict(row):
    return {
        "id": row["id"],
        "task_id": row["task_id"],
        "title": row["title"],
        "done": bool(row["done"]),
        "position": row["position"],
        "created_at": row["created_at"],
    }


def comment_dict(row):
    return {
        "id": row["id"],
        "task_id": row["task_id"],
        "user_id": row["user_id"],
        "text": row["text"],
        "created_at": row["created_at"],
    }


def attachment_dict(row):
    return {
        "id": row["id"],
        "task_id": row["task_id"],
        "filename": row["filename"],
        "size_bytes": row["size_bytes"],
        "uploaded_at": row["uploaded_at"],
    }


def time_entry_dict(row):
    return {
        "id": row["id"],
        "task_id": row["task_id"],
        "user_id": row["user_id"],
        "description": row["description"],
        "started_at": row["started_at"],
        "stopped_at": row["stopped_at"],
        "duration_seconds": row["duration_seconds"],
        "created_at": row["created_at"],
    }


# ------------------------------------------------------------
# Проект: доска + её описание, обновления и документы
# ------------------------------------------------------------
def project_dict(row):
    return {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"],
        "docs_public": bool(row["docs_public"]),
        "public_token": row["public_token"],
        "created_at": row["created_at"],
    }


def project_update_dict(row):
    return {
        "id": row["id"],
        "board_id": row["board_id"],
        "user_id": row["user_id"],
        "title": row["title"],
        "text": row["text"],
        "entry_date": row["entry_date"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


# Типы, которые умеет показать встроенный просмотрщик приложения.
# Правила те же, что у вложений задачи: картинка — в <img>, PDF — во
# фрейме, текст — в <pre>. HTML и SVG в этот список не входят
# намеренно: встроенные в страницу приложения, они выполнили бы свой
# скрипт на том же origin и получили бы доступ к API.
DOC_IMAGE_RE = re.compile(r"\.(jpg|jpeg|png|gif|webp|svg|bmp|ico)$", re.I)
DOC_PDF_RE = re.compile(r"\.pdf$", re.I)
DOC_TEXT_RE = re.compile(
    r"\.(txt|md|markdown|log|csv|tsv|json|xml|ya?ml|ini|cfg|conf|toml|env|py|js|mjs|cjs|ts|tsx|jsx"
    r"|css|html?|sh|bash|bat|cmd|ps1|sql|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|vue|gitignore|editorconfig)$",
    re.I,
)


def document_preview_kind(filename):
    if DOC_IMAGE_RE.search(filename or ""):
        return "image"
    if DOC_PDF_RE.search(filename or ""):
        return "pdf"
    if DOC_TEXT_RE.search(filename or ""):
        return "text"
    return None


def project_document_dict(row):
    return {
        "id": row["id"],
        "board_id": row["board_id"],
        "filename": row["filename"],
        "size_bytes": row["size_bytes"],
        "preview": document_preview_kind(row["filename"]),
        "mime": mimetypes.guess_type(row["filename"])[0] or "application/octet-stream",
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def event_dict(row):
    return {
        "id": row["id"],
        "board_id": row["board_id"],
        "user_id": row["user_id"],
        "kind": row["kind"],
        "text": row["text"],
        "created_at": row["created_at"],
    }


def actor_id():
    """Кто выполняет изменение.

    Фронтенд шлёт текущего пользователя заголовком на любое изменение
    (core/api.js), поэтому подписи событий не нужно дописывать в каждом
    месте вручную. Заголовка нет — событие останется без автора, а не
    будет врать.
    """
    raw = request.headers.get("X-QuestLog-User")
    try:
        return int(raw) if raw else None
    except (TypeError, ValueError):
        return None


def log_event(board_id, kind, text):
    """Запись в ленту событий проекта. Ошибки не блокируют основное действие."""
    if not board_id:
        return
    try:
        get_db().execute(
            "INSERT INTO project_events (board_id, user_id, kind, text, created_at) VALUES (?,?,?,?,?)",
            (board_id, actor_id(), kind, text, now_iso()),
        )
    except sqlite3.Error:
        pass


def document_dir(board_id):
    """Папка документов проекта — физически привязана к конкретной доске."""
    path = os.path.join(DOC_DIR, str(board_id))
    os.makedirs(path, exist_ok=True)
    return path


def safe_document_name(name):
    """Имя файла без пути и управляющих символов — им же заполняем ZIP."""
    cleaned = (name or "").replace("\\", "/").split("/")[-1]
    cleaned = "".join(ch for ch in cleaned if ch.isprintable() and ch not in '<>:"|?*')
    cleaned = cleaned.strip().strip(".")
    return cleaned[:180]


def unique_archive_name(name, taken):
    """Два файла могут называться одинаково — второй получит суффикс."""
    if name not in taken:
        taken.add(name)
        return name
    stem, dot, ext = name.rpartition(".")
    index = 2
    while True:
        candidate = f"{stem} ({index}){dot}{ext}" if dot else f"{name} ({index})"
        if candidate not in taken:
            taken.add(candidate)
            return candidate
        index += 1


# ============================================================
# Static frontend
# ============================================================
@app.route("/api/health")
def health():
    """Lightweight marker used by desktop.py to detect a running instance."""
    return jsonify({"ok": True, "app": "QuestLog"})


@app.route("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.route("/static/<path:path>")
def static_files(path):
    return send_from_directory(STATIC_DIR, path)


# ============================================================
# Boards
# ============================================================
@app.route("/api/boards", methods=["GET"])
def list_boards():
    db = get_db()
    rows = db.execute("SELECT * FROM boards ORDER BY id").fetchall()
    return jsonify([{"id": r["id"], "name": r["name"]} for r in rows])


@app.route("/api/boards", methods=["POST"])
def create_board():
    data = request.get_json(force=True)
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "Название доски обязательно"}), 400
    db = get_db()
    cur = db.execute("INSERT INTO boards (name, created_at) VALUES (?,?)", (name, now_iso()))
    board_id = cur.lastrowid
    for i, cname in enumerate(DEFAULT_COLUMNS):
        db.execute(
            "INSERT INTO columns (board_id, name, position, is_done_state) VALUES (?,?,?,?)",
            (board_id, cname, i, 1 if cname in ("Done", "Cancelled") else 0),
        )
    db.commit()
    return jsonify({"id": board_id, "name": name}), 201
@app.route("/api/boards/<int:board_id>", methods=["PUT"])
def rename_board(board_id):
    """Переименование доски и правка описания проекта.

    Оба поля необязательны по отдельности, но пустое имя по-прежнему
    отклоняется: переименование — единственный способ сменить заголовок.
    """
    data = request.get_json(force=True)
    db = get_db()
    board = db.execute("SELECT id FROM boards WHERE id=?", (board_id,)).fetchone()
    if not board:
        return jsonify({"error": "Доска не найдена"}), 404

    fields = {}
    if "name" in data:
        name = (data["name"] or "").strip()
        if not name:
            return jsonify({"error": "Название доски обязательно"}), 400
        fields["name"] = name
    if "description" in data:
        description = data["description"] or ""
        if len(description) > MAX_PROJECT_DESC_CHARS:
            return jsonify({"error": f"Описание длиннее {MAX_PROJECT_DESC_CHARS} символов"}), 400
        fields["description"] = description
    if not fields:
        return jsonify({"error": "Нечего сохранять"}), 400

    set_clause = ", ".join(f"{k}=?" for k in fields)
    db.execute(f"UPDATE boards SET {set_clause} WHERE id=?", (*fields.values(), board_id))
    db.commit()
    if "name" in fields:
        log_event(board_id, "project_renamed", f"Проект переименован в «{fields['name']}»")
    if "description" in fields and fields["description"]:
        log_event(board_id, "project_description", "Обновлено описание проекта")
    db.commit()
    row = db.execute("SELECT * FROM boards WHERE id=?", (board_id,)).fetchone()
    return jsonify(project_dict(row))


@app.route("/api/boards/<int:board_id>/project", methods=["GET"])
def get_project(board_id):
    """Всё содержимое drawer-а одним запросом: описание, обновления, документы."""
    db = get_db()
    board = db.execute("SELECT * FROM boards WHERE id=?", (board_id,)).fetchone()
    if not board:
        abort(404)
    updates = db.execute(
        "SELECT * FROM project_updates WHERE board_id=? ORDER BY entry_date DESC, id DESC",
        (board_id,),
    ).fetchall()
    documents = db.execute(
        "SELECT * FROM project_documents WHERE board_id=? ORDER BY created_at DESC, id DESC",
        (board_id,),
    ).fetchall()
    events = db.execute(
        "SELECT * FROM project_events WHERE board_id=? ORDER BY id DESC LIMIT ?",
        (board_id, EVENT_LIMIT),
    ).fetchall()
    return jsonify(
        {
            "project": project_dict(board),
            "updates": [project_update_dict(u) for u in updates],
            "documents": [project_document_dict(d) for d in documents],
            "events": [event_dict(e) for e in events],
            "digest": project_digest(board_id),
        }
    )


@app.route("/api/boards/<int:board_id>/events", methods=["GET"])
def list_project_events(board_id):
    """Лента изменений проекта, свежие сверху."""
    limit = max(1, min(request.args.get("limit", default=100, type=int), 500))
    db = get_db()
    if not db.execute("SELECT id FROM boards WHERE id=?", (board_id,)).fetchone():
        abort(404)
    rows = db.execute(
        "SELECT * FROM project_events WHERE board_id=? ORDER BY id DESC LIMIT ?",
        (board_id, limit),
    ).fetchall()
    return jsonify([event_dict(r) for r in rows])


# ------------------------------------------------------------
# Досье проекта: всё, что известно о проекте, одной страницей
# ------------------------------------------------------------
def _stuck_tasks(tasks, columns, users):
    """Зависшие задачи: по ним видно, где проект буксует.

    Зависшая — не в завершающей колонке и при этом хотя бы одно из трёх:
    без исполнителя, срок уже прошёл, либо её не трогали дольше двух недель.
    """
    today = datetime.date.today()
    stale_before = (
        datetime.datetime.now() - datetime.timedelta(days=STUCK_STALE_DAYS)
    ).isoformat(timespec="seconds")
    done_ids = {c["id"] for c in columns if c["is_done_state"]}
    column_names = {c["id"]: c["name"] for c in columns}

    result = []
    for task in tasks:
        if task["column_id"] in done_ids:
            continue
        reasons = []
        if not task["assignee_id"] or task["assignee_id"] not in users:
            reasons.append("без исполнителя")
        if task["due_date"]:
            try:
                if datetime.date.fromisoformat(task["due_date"]) < today:
                    reasons.append("срок прошёл")
            except ValueError:
                pass  # некорректный срок — просто не считаем его прошедшим
        if (task["updated_at"] or "") < stale_before:
            reasons.append(f"без движения {STUCK_STALE_DAYS} дн.")
        if not reasons:
            continue
        result.append(
            {
                "id": task["id"],
                "title": task["title"],
                "column": column_names.get(task["column_id"], ""),
                "assignee": users[task["assignee_id"]]["name"]
                if task["assignee_id"] in users
                else "Без исполнителя",
                "due_date": task["due_date"] or "",
                "updated_at": task["updated_at"] or "",
                "reasons": reasons,
            }
        )
    # Сначала те, у которых причина серьёзнее: сортируем по числу причин.
    result.sort(key=lambda t: (-len(t["reasons"]), t["updated_at"]))
    return result


def _project_report_data(board_id):
    """Собирает данные отчёта. Общая часть для JSON и HTML-страницы."""
    db = get_db()
    board = db.execute("SELECT * FROM boards WHERE id=?", (board_id,)).fetchone()
    if not board:
        abort(404)

    columns = db.execute(
        "SELECT * FROM columns WHERE board_id=? ORDER BY position", (board_id,)
    ).fetchall()
    users = {u["id"]: u for u in db.execute("SELECT * FROM users ORDER BY id").fetchall()}

    tasks = db.execute(
        "SELECT * FROM tasks WHERE board_id=? ORDER BY created_at", (board_id,)
    ).fetchall()

    # Время по задачам: сумма длительностей и признак «таймер идёт».
    time_by_task = {
        r["task_id"]: (r["total"], bool(r["running"]))
        for r in db.execute(
            """SELECT task_id, COALESCE(SUM(duration_seconds), 0) AS total,
                      MAX(CASE WHEN stopped_at IS NULL THEN 1 ELSE 0 END) AS running
               FROM time_entries GROUP BY task_id"""
        ).fetchall()
    }

    done_columns = {c["id"] for c in columns if c["is_done_state"]}
    by_column = []
    for column in columns:
        in_column = [t for t in tasks if t["column_id"] == column["id"]]
        by_column.append(
            {
                "name": column["name"],
                "total": len(in_column),
                "done": bool(column["is_done_state"]),
            }
        )

    by_assignee = {}
    for task in tasks:
        key = task["assignee_id"]
        entry = by_assignee.setdefault(
            key,
            {
                "user_id": key,
                "name": users[key]["name"] if key in users else "Без исполнителя",
                "color": users[key]["color"] if key in users else None,
                "tasks": 0,
                "done": 0,
                "time_seconds": 0,
            },
        )
        entry["tasks"] += 1
        if task["column_id"] in done_columns:
            entry["done"] += 1
        entry["time_seconds"] += time_by_task.get(task["id"], (0, False))[0]

    by_priority = {"high": 0, "medium": 0, "normal": 0, "low": 0}
    tag_counts = {}
    for task in tasks:
        by_priority[task["priority"]] = by_priority.get(task["priority"], 0) + 1
        for tag in (t for t in task["tags"].split(",") if t):
            tag_counts[tag] = tag_counts.get(tag, 0) + 1

    done_count = sum(1 for t in tasks if t["column_id"] in done_columns)
    stuck = _stuck_tasks(tasks, columns, users)
    documents = db.execute(
        "SELECT * FROM project_documents WHERE board_id=? ORDER BY created_at, id", (board_id,)
    ).fetchall()
    updates = db.execute(
        "SELECT * FROM project_updates WHERE board_id=? ORDER BY entry_date DESC, id DESC",
        (board_id,),
    ).fetchall()
    doc_size = sum(d["size_bytes"] for d in documents)

    created_at = board["created_at"]
    last_activity = max(
        [t["updated_at"] for t in tasks] + [d["updated_at"] for d in documents] or [created_at]
    )

    return {
        "project": project_dict(board),
        "generated_at": now_iso(),
        "created_at": created_at,
        "last_activity_at": last_activity,
        "totals": {
            "tasks": len(tasks),
            "done": done_count,
            "active": len(tasks) - done_count,
            "documents": len(documents),
            "documents_size": doc_size,
            "updates": len(updates),
            "time_seconds": sum(v[0] for v in time_by_task.values()),
            "running_timers": sum(1 for v in time_by_task.values() if v[1]),
        },
        "by_column": by_column,
        "stuck": stuck,
        "by_assignee": sorted(by_assignee.values(), key=lambda e: (-e["tasks"], e["name"])),
        "by_priority": by_priority,
        "top_tags": sorted(
            ({"tag": t, "count": c} for t, c in tag_counts.items()),
            key=lambda e: (-e["count"], e["tag"]),
        )[:8],
        "updates": [project_update_dict(u) for u in updates],
        "documents": [project_document_dict(d) for d in documents],
    }


@app.route("/api/boards/<int:board_id>/report")
def project_report(board_id):
    return jsonify(_project_report_data(board_id))


@app.route("/api/boards/<int:board_id>/report.html")
def project_report_page(board_id):
    """Отчёт одной страницей: открывается во вкладке, печатается в PDF
    через диалог печати браузера. Считает всё, что уже есть в доске."""
    theme = request.args.get("theme") if request.args.get("theme") in THEMES else "retro"
    return _report_page(board_id, theme=theme)


def _report_page(board_id, theme="retro", standalone=False):
    """Собирает страницу отчёта.

    standalone=True кладёт стили прямо в страницу: такой отчёт открывается
    из папки на чужом компьютере, где нет ни QuestLog, ни /static/style.css.
    """
    data = _project_report_data(board_id)
    totals = data["totals"]
    project = data["project"]

    def esc(value):
        return html.escape(value or "", quote=True)

    def duration(seconds):
        s = max(0, int(seconds or 0))
        h, m = s // 3600, (s % 3600) // 60
        if h and m:
            return f"{h} ч {m} мин"
        if h:
            return f"{h} ч"
        return f"{m} мин" if m else "меньше минуты"

    def duration_short(seconds):
        """Тот же формат, но короче: в плитках «104 ч 57 мин» переносится
        на две строки и ломает сетку итогов."""
        s = max(0, int(seconds or 0))
        h, m = s // 3600, (s % 3600) // 60
        if h >= 10:
            return f"{h} ч"
        if h:
            return f"{h} ч {m} мин"
        return f"{m} мин" if m else "меньше минуты"

    def duration_cell(seconds):
        """Для таблиц: у нуля вместо слов прочерк — колонка не должна
        разрастаться из-за одного «меньше минуты»."""
        return "—" if int(seconds or 0) <= 0 else duration_short(seconds)

    stuck_rows = "".join(
        f"""      <tr>
        <td>{esc(t['title'])}<span class="report-stuck-reasons">{esc(', '.join(t['reasons']))}</span></td>
        <td>{esc(t['assignee'])}</td>
        <td>{esc(t['column'])}</td>
        <td class="num">{esc(t['due_date'][10:].replace('-', '.') if t['due_date'] else '—')}</td>
      </tr>"""
        for t in data["stuck"]
    ) or '      <tr><td colspan="4" class="report-empty">Зависших задач нет</td></tr>'

    max_column = max((c["total"] for c in data["by_column"]), default=0) or 1
    column_rows = "".join(
        f"""      <li class="report-bar-row">
        <span class="report-bar-name">{esc(c['name'])}</span>
        <span class="report-bar-track"><span class="report-bar-fill{' done' if c['done'] else ''}"
              style="width: {round(c['total'] / max_column * 100)}%"></span></span>
        <span class="report-bar-value">{c['total']}</span>
      </li>"""
        for c in data["by_column"]
    )

    assignee_rows = "".join(
        f"""      <tr>
        <td>{esc(e['name'])}</td>
        <td class="num">{e['done']} / {e['tasks']}</td>
        <td class="num">{duration_cell(e['time_seconds'])}</td>
      </tr>"""
        for e in data["by_assignee"]
    ) or '      <tr><td colspan="3" class="report-empty">Задачи ещё не назначены</td></tr>'

    priority_rows = "".join(
        f"""      <li class="report-chip-row"><span class="report-priority priority-{key}">
          {esc(PRIORITY_LABELS.get(key, key))}</span><b>{count}</b></li>"""
        for key, count in data["by_priority"].items()
        if count
    ) or '      <li class="report-empty">Нет задач</li>'

    tag_rows = "".join(
        f'      <span class="report-tag">{esc(t["tag"])} <b>{t["count"]}</b></span>'
        for t in data["top_tags"]
    ) or '<span class="report-empty">Тегов пока нет</span>'

    update_items = "".join(
        f"""      <li class="report-update">
        <span class="report-update-date">{esc(_format_entry_date(u['entry_date']))}</span>
        <b>{esc(u['title'])}</b>
        {f'<p>{esc(u["text"])}</p>' if u["text"] else ""}
      </li>"""
        for u in data["updates"]
    ) or '      <li class="report-empty">Обновлений пока нет</li>'

    document_rows = "".join(
        f"""      <tr><td>{esc(d['filename'])}</td><td class="num">{esc(_format_size(d['size_bytes']))}</td>
        <td class="num">{esc(d['updated_at'][:10])}</td></tr>"""
        for d in data["documents"]
    ) or '      <tr><td colspan="3" class="report-empty">Документов пока нет</td></tr>'

    completion = round(totals["done"] / totals["tasks"] * 100) if totals["tasks"] else 0

    styles = (
        f"<style>\n{_static_css()}\n</style>"
        if standalone
        else '<link rel="stylesheet" href="/static/style.css">'
    )

    return f"""<!DOCTYPE html>
<html lang="ru" data-theme="{theme}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Отчёт по проекту «{esc(project['name'])}» · QuestLog</title>
{styles}
</head>
<body class="report-page">
  <main class="report-card">
    <header class="report-head">
      <div class="report-brand">QuestLog · досье проекта</div>
      <h1>{esc(project['name'])}</h1>
      <p class="report-meta">Собрано {esc(data['generated_at'][:16].replace('T', ', '))} · проект живёт с {esc(data['created_at'][:10])} · последнее изменение {esc(data['last_activity_at'][:10])}</p>
    </header>

    <section class="report-totals">
      <div class="report-total"><b>{totals['tasks']}</b><span>задач</span></div>
      <div class="report-total"><b>{completion}%</b><span>выполнено</span></div>
      <div class="report-total"><b>{duration_short(totals['time_seconds'])}</b><span>затрачено</span></div>
      <div class="report-total"><b>{totals['updates']}</b><span>обновлений</span></div>
      <div class="report-total"><b>{totals['documents']}</b><span>документов, {_format_size(totals['documents_size'])}</span></div>
    </section>

    <section class="report-section">
      <h2>Описание</h2>
      <p class="report-desc">{esc(project['description']) or 'Описание пока не заполнено.'}</p>
    </section>

    <section class="report-section">
      <h2>Задачи по колонкам</h2>
      <ul class="report-bars">{column_rows}</ul>
    </section>

    <section class="report-section">
      <h2>Зависшие задачи</h2>
      <p class="report-note">Без исполнителя, с просроченным сроком или без движения больше {STUCK_STALE_DAYS} дней — всё, что мешает проекту идти.</p>
      <table class="report-table">
        <thead><tr><th>Задача</th><th>Исполнитель</th><th>Колонка</th><th class="num">срок</th></tr></thead>
        <tbody>{stuck_rows}</tbody>
      </table>
    </section>

    <section class="report-section report-two-col">
      <div>
        <h2>Люди</h2>
        <table class="report-table">
          <thead><tr><th>Участник</th><th class="num">готово</th><th class="num">время</th></tr></thead>
          <tbody>{assignee_rows}</tbody>
        </table>
      </div>
      <div>
        <h2>Приоритеты и теги</h2>
        <ul class="report-chips">{priority_rows}</ul>
        <div class="report-tags">{tag_rows}</div>
      </div>
    </section>

    <section class="report-section">
      <h2>История обновлений</h2>
      <ol class="report-updates">{update_items}</ol>
    </section>

    <section class="report-section">
      <h2>Документы</h2>
      <table class="report-table">
        <thead><tr><th>Файл</th><th class="num">размер</th><th class="num">изменён</th></tr></thead>
        <tbody>{document_rows}</tbody>
      </table>
    </section>

    <footer class="report-foot">
      Отчёт собран из данных доски. «Готово» считается по колонкам со статусом
      «завершающим» (по умолчанию Done и Cancelled).
    </footer>
  </main>
</body>
</html>
"""


@app.route("/api/boards/<int:board_id>/sharing", methods=["PUT"])
def set_project_sharing(board_id):
    """Публичный доступ к документации проекта по ссылке.

    Отдельной системы прав в приложении нет: «только участники» — это
    обычный доступ из приложения, а включённый переключатель добавляет
    ещё одно отверстие: страницу по неугадываемому токену, доступную
    любому, у кого есть ссылка.
    """
    data = request.get_json(force=True)
    is_public = data.get("is_public")
    if not isinstance(is_public, bool):
        return jsonify({"error": "is_public должен быть true или false"}), 400
    db = get_db()
    board = db.execute("SELECT * FROM boards WHERE id=?", (board_id,)).fetchone()
    if not board:
        return jsonify({"error": "Доска не найдена"}), 404

    # Токен создаётся один раз и переживает выключение — иначе старая
    # ссылка из письма перестала бы работать после повторного включения.
    token = board["public_token"]
    if is_public and not token:
        token = uuid.uuid4().hex
    db.execute(
        "UPDATE boards SET docs_public=?, public_token=? WHERE id=?",
        (1 if is_public else 0, token, board_id),
    )
    db.commit()
    log_event(board_id, "sharing_changed", "Документация открыта по публичной ссылке" if is_public else "Публичная ссылка отключена")
    db.commit()
    return jsonify(
        {
            "docs_public": is_public,
            "public_token": token if is_public else None,
            "public_path": f"/public/docs/{token}" if is_public else None,
        }
    )


# ------------------------------------------------------------
# Обновления проекта (changelog)
# ------------------------------------------------------------
@app.route("/api/boards/<int:board_id>/updates", methods=["POST"])
def create_project_update(board_id):
    data = request.get_json(force=True)
    title = (data.get("title") or "").strip()
    if not title:
        return jsonify({"error": "Заголовок обновления обязателен"}), 400
    entry_date = valid_due_date(data.get("entry_date", ""))
    if entry_date is None:
        return jsonify({"error": "Некорректная дата обновления"}), 400
    if not entry_date:
        entry_date = datetime.date.today().isoformat()

    db = get_db()
    if not db.execute("SELECT id FROM boards WHERE id=?", (board_id,)).fetchone():
        abort(404)
    ts = now_iso()
    cur = db.execute(
        """INSERT INTO project_updates (board_id, user_id, title, text, entry_date, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?)""",
        (board_id, data.get("user_id"), title, data.get("text") or "", entry_date, ts, ts),
    )
    db.commit()
    row = db.execute("SELECT * FROM project_updates WHERE id=?", (cur.lastrowid,)).fetchone()
    log_event(board_id, "update_added", f"Обновление «{title}»")
    db.commit()
    return jsonify(project_update_dict(row)), 201


@app.route("/api/project-updates/<int:update_id>", methods=["PUT"])
def update_project_update(update_id):
    data = request.get_json(force=True)
    db = get_db()
    row = db.execute("SELECT * FROM project_updates WHERE id=?", (update_id,)).fetchone()
    if not row:
        return jsonify({"error": "Обновление не найдено"}), 404

    fields = {}
    if "title" in data:
        title = (data["title"] or "").strip()
        if not title:
            return jsonify({"error": "Заголовок обновления обязателен"}), 400
        fields["title"] = title
    if "text" in data:
        fields["text"] = data["text"] or ""
    if "entry_date" in data:
        entry_date = valid_due_date(data["entry_date"])
        if entry_date is None:
            return jsonify({"error": "Некорректная дата обновления"}), 400
        if entry_date:
            fields["entry_date"] = entry_date
    if not fields:
        return jsonify({"error": "Нечего сохранять"}), 400

    fields["updated_at"] = now_iso()
    set_clause = ", ".join(f"{k}=?" for k in fields)
    db.execute(f"UPDATE project_updates SET {set_clause} WHERE id=?", (*fields.values(), update_id))
    db.commit()
    log_event(row["board_id"], "update_edited", f"Обновление «{fields.get('title', row['title'])}» изменено")
    db.commit()
    row = db.execute("SELECT * FROM project_updates WHERE id=?", (update_id,)).fetchone()
    return jsonify(project_update_dict(row))


@app.route("/api/project-updates/<int:update_id>", methods=["DELETE"])
def delete_project_update(update_id):
    db = get_db()
    row = db.execute("SELECT board_id, title FROM project_updates WHERE id=?", (update_id,)).fetchone()
    db.execute("DELETE FROM project_updates WHERE id=?", (update_id,))
    db.commit()
    if row:
        log_event(row["board_id"], "update_deleted", f"Обновление «{row['title']}» удалено")
        db.commit()
    return jsonify({"ok": True})


# ------------------------------------------------------------
# Документы проекта
# ------------------------------------------------------------
@app.route("/api/boards/<int:board_id>/documents", methods=["POST"])
def upload_project_document(board_id):
    db = get_db()
    if not db.execute("SELECT id FROM boards WHERE id=?", (board_id,)).fetchone():
        abort(404)
    if "file" not in request.files:
        return jsonify({"error": "Файл не передан"}), 400
    file = request.files["file"]
    original_name = safe_document_name(file.filename)
    if not original_name:
        return jsonify({"error": "Пустое имя файла"}), 400

    ext = os.path.splitext(original_name)[1]
    stored_name = f"{uuid.uuid4().hex}{ext}"
    file.save(os.path.join(document_dir(board_id), stored_name))
    size = os.path.getsize(os.path.join(document_dir(board_id), stored_name))

    ts = now_iso()
    cur = db.execute(
        """INSERT INTO project_documents (board_id, filename, stored_name, size_bytes, created_at, updated_at)
           VALUES (?,?,?,?,?,?)""",
        (board_id, original_name, stored_name, size, ts, ts),
    )
    db.commit()
    row = db.execute("SELECT * FROM project_documents WHERE id=?", (cur.lastrowid,)).fetchone()
    log_event(board_id, "doc_added", f"Документ «{original_name}» загружен")
    db.commit()
    return jsonify(project_document_dict(row)), 201


@app.route("/api/boards/<int:board_id>/documents/text", methods=["POST"])
def create_project_text_document(board_id):
    """Создать текстовый документ прямо в приложении.

    Обновления в проекте пишутся на месте, а из документов раньше можно было
    только загрузить готовый файл — из-за этого простую заметку приходилось
    заводить в проводнике. Файл остаётся обычным файлом в папке доски: то,
    что создано здесь, потом так же скачивается и правится снаружи.
    """
    data = request.get_json(force=True)
    db = get_db()
    if not db.execute("SELECT id FROM boards WHERE id=?", (board_id,)).fetchone():
        abort(404)

    filename = safe_document_name(data.get("filename"))
    if not filename:
        return jsonify({"error": "Имя документа обязательно"}), 400
    # Формат задаёт приложение, а не человек: документы, созданные здесь,
    # всегда текстовые. Написал текстовое расширение — оставляем (так тоже
    # понятно), написал другое или не написал ничего — markdown.
    if document_preview_kind(filename) != "text":
        filename = f"{os.path.splitext(filename)[0]}.md"

    body = data.get("text") or ""
    if len(body.encode("utf-8")) > MAX_TEXT_DOCUMENT_BYTES:
        return jsonify({"error": "Документ слишком большой"}), 400

    if db.execute(
        "SELECT 1 FROM project_documents WHERE board_id=? AND filename=?",
        (board_id, filename),
    ).fetchone():
        return jsonify({"error": "Документ с таким именем уже есть"}), 409

    stored_name = f"{uuid.uuid4().hex}{os.path.splitext(filename)[1]}"
    path = os.path.join(document_dir(board_id), stored_name)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(body)

    ts = now_iso()
    cur = db.execute(
        """INSERT INTO project_documents (board_id, filename, stored_name, size_bytes, created_at, updated_at)
           VALUES (?,?,?,?,?,?)""",
        (board_id, filename, stored_name, os.path.getsize(path), ts, ts),
    )
    db.commit()
    row = db.execute("SELECT * FROM project_documents WHERE id=?", (cur.lastrowid,)).fetchone()
    log_event(board_id, "doc_added", f"Документ «{filename}» создан")
    db.commit()
    return jsonify(project_document_dict(row)), 201


@app.route("/api/project-documents/<int:doc_id>/content", methods=["GET"])
def read_project_document_content(doc_id):
    """Содержимое текстового документа плюс отпечаток файла.

    Отпечаток (размер и время изменения) нужен, чтобы при сохранении не
    затереть правку, сделанную в файле снаружи, пока документ был открыт.
    """
    row = _text_document_row(doc_id)
    if row is None:
        return jsonify({"error": "Документ не найден или не текстовый"}), 404
    path = os.path.join(document_dir(row["board_id"]), row["stored_name"])
    if not os.path.exists(path):
        abort(404)
    with open(path, encoding="utf-8", errors="replace") as fh:
        text = fh.read()
    return jsonify(
        {"filename": row["filename"], "text": text, "stamp": _file_stamp(path)}
    )


@app.route("/api/project-documents/<int:doc_id>/content", methods=["PUT"])
def write_project_document_content(doc_id):
    """Сохранить содержимое текстового документа на диск."""
    data = request.get_json(force=True)
    row = _text_document_row(doc_id)
    if row is None:
        return jsonify({"error": "Документ не найден или не текстовый"}), 404

    body = data.get("text")
    if not isinstance(body, str):
        return jsonify({"error": "Нужен текст документа"}), 400
    if len(body.encode("utf-8")) > MAX_TEXT_DOCUMENT_BYTES:
        return jsonify({"error": "Документ слишком большой"}), 400

    path = os.path.join(document_dir(row["board_id"]), row["stored_name"])
    if not os.path.exists(path):
        abort(404)

    sent_stamp = data.get("stamp")
    if sent_stamp and sent_stamp != _file_stamp(path):
        # Файл трогали мимо приложения — молча перезаписать его нельзя.
        return jsonify({"error": "Файл изменился на диске — откройте его заново"}), 409

    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(body)
    db = get_db()
    db.execute(
        "UPDATE project_documents SET size_bytes=?, updated_at=? WHERE id=?",
        (os.path.getsize(path), now_iso(), doc_id),
    )
    db.commit()
    log_event(row["board_id"], "doc_edited", f"Документ «{row['filename']}» изменён")
    db.commit()
    row = db.execute("SELECT * FROM project_documents WHERE id=?", (doc_id,)).fetchone()
    return jsonify(project_document_dict(row))


def _text_document_row(doc_id):
    """Строка документа, если его можно открыть текстом, иначе None."""
    db = get_db()
    row = db.execute("SELECT * FROM project_documents WHERE id=?", (doc_id,)).fetchone()
    if row and document_preview_kind(row["filename"]) == "text":
        return row
    return None


def _file_stamp(path):
    """Отпечаток файла для защиты от перезаписи чужой правки."""
    stat = os.stat(path)
    return f"{stat.st_size}-{int(stat.st_mtime)}"


@app.route("/api/project-documents/<int:doc_id>", methods=["PUT"])
def rename_project_document(doc_id):
    data = request.get_json(force=True)
    db = get_db()
    row = db.execute("SELECT * FROM project_documents WHERE id=?", (doc_id,)).fetchone()
    if not row:
        return jsonify({"error": "Документ не найден"}), 404

    new_name = safe_document_name(data.get("filename"))
    if not new_name:
        return jsonify({"error": "Имя файла обязательно"}), 400
    # Расширение менять нельзя: содержимое файла от переименования не
    # меняется, а подпись и просмотрщик смотрят именно на него. Назвать
    # картинку «смета.txt» — значит соврать о типе. Присланное чужое
    # расширение отбрасываем, исходное возвращаем всегда: иначе документ
    # мог бы остаться без расширения вообще и стал бы неоткрываемым.
    base, ext = os.path.splitext(new_name)
    original_ext = os.path.splitext(row["filename"])[1]
    if ext and ext.lower() != original_ext.lower():
        new_name = base or new_name
    if not os.path.splitext(new_name)[1]:
        new_name += original_ext
    # Два файла с одинаковым именем в списке выглядят как ошибка, а на диске
    # лежат под случайными именами и молча перетирают друг друга при выгрузке.
    taken = db.execute(
        "SELECT 1 FROM project_documents WHERE board_id=? AND filename=? AND id<>?",
        (row["board_id"], new_name, doc_id),
    ).fetchone()
    if taken:
        return jsonify({"error": "Документ с таким именем уже есть"}), 409

    db.execute(
        "UPDATE project_documents SET filename=?, updated_at=? WHERE id=?",
        (new_name, now_iso(), doc_id),
    )
    db.commit()
    log_event(row["board_id"], "doc_renamed", f"Документ переименован: «{row['filename']}» → «{new_name}»")
    db.commit()
    row = db.execute("SELECT * FROM project_documents WHERE id=?", (doc_id,)).fetchone()
    return jsonify(project_document_dict(row))


@app.route("/api/project-documents/<int:doc_id>", methods=["DELETE"])
def delete_project_document(doc_id):
    db = get_db()
    row = db.execute("SELECT * FROM project_documents WHERE id=?", (doc_id,)).fetchone()
    if row:
        path = os.path.join(document_dir(row["board_id"]), row["stored_name"])
        if os.path.exists(path):
            os.remove(path)
        db.execute("DELETE FROM project_documents WHERE id=?", (doc_id,))
        db.commit()
        log_event(row["board_id"], "doc_deleted", f"Документ «{row['filename']}» удалён")
        db.commit()
    return jsonify({"ok": True})


@app.route("/api/project-documents/<int:doc_id>/download")
def download_project_document(doc_id):
    db = get_db()
    row = db.execute("SELECT * FROM project_documents WHERE id=?", (doc_id,)).fetchone()
    if not row:
        abort(404)
    mime = mimetypes.guess_type(row["filename"])[0] or "application/octet-stream"
    # ?inline=1 — превью в лайтбоксе: браузер рисует PDF во фрейме только
    # при Content-Disposition: inline, с attachment он молча скачивает файл.
    inline_preview = request.args.get("inline") == "1" and mime in INLINE_PREVIEW_MIMES
    return send_from_directory(
        document_dir(row["board_id"]), row["stored_name"], as_attachment=not inline_preview,
        download_name=row["filename"], mimetype=mime,
    )


def _project_changelog_text(updates):
    """Обновления проекта обычным текстом — для архива и публичной страницы."""
    if not updates:
        return ""
    lines = []
    for u in updates:
        lines.append(f"## {u['entry_date']} — {u['title']}")
        if u["text"]:
            lines.append("")
            lines.append(u["text"])
        lines.append("")
    return "\n".join(lines)


@app.route("/api/boards/<int:board_id>/dossier")
def download_project_dossier(board_id):
    """Досье проекта одним архивом, который читается без QuestLog.

    Внутри — самодостаточная страница отчёта со встроенными стилями,
    история обновлений, лента событий и сами документы. Отдал архив
    человеку: он открыл папку и прочитал проект, даже если приложение
    закрыто, а у него QuestLog нет.
    """
    db = get_db()
    board = db.execute("SELECT * FROM boards WHERE id=?", (board_id,)).fetchone()
    if not board:
        abort(404)
    documents = db.execute(
        "SELECT * FROM project_documents WHERE board_id=? ORDER BY created_at, id", (board_id,)
    ).fetchall()
    updates = db.execute(
        "SELECT * FROM project_updates WHERE board_id=? ORDER BY entry_date DESC, id DESC",
        (board_id,),
    ).fetchall()
    events = db.execute(
        "SELECT * FROM project_events WHERE board_id=? ORDER BY id", (board_id,)
    ).fetchall()
    users = {
        r["id"]: r["name"]
        for r in db.execute("SELECT id, name FROM users").fetchall()
    }

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("досье.html", _report_page(board_id, standalone=True))
        changelog = _project_changelog_text(updates)
        archive.writestr("обновления.md", changelog or "Обновлений пока нет.")
        archive.writestr("события.md", _events_markdown(events, users))
        archive.writestr(
            "задачи.txt",
            _tasks_plain_text(
                board,
                db.execute(
                    "SELECT * FROM columns WHERE board_id=? ORDER BY position", (board_id,)
                ).fetchall(),
                db.execute(
                    "SELECT * FROM tasks WHERE board_id=? ORDER BY created_at", (board_id,)
                ).fetchall(),
                users,
            ),
        )
        taken = set()
        folder = document_dir(board_id)
        for doc in documents:
            path = os.path.join(folder, doc["stored_name"])
            if not os.path.exists(path):
                continue  # файл могли удалить с диска вручную — не ломаем архив
            # Имя в архиве — только базовое, без пути: иначе файл с именем
            # «../../что-то» распаковался бы вне папки (Zip Slip).
            archive.write(path, f"документы/{unique_archive_name(doc['filename'], taken)}")
    buffer.seek(0)
    return send_file(
        buffer,
        mimetype="application/zip",
        as_attachment=True,
        download_name=f"{safe_document_name(board['name']) or 'проект'}-досье.zip",
    )


def _tasks_plain_text(board, columns, tasks, users):
    """Задачи по колонкам обычным текстом — чтобы вставить в письмо.

    В письме не нужен ни HTML, ни архив: достаточно списка, который
    читается в любом редакторе, даже в блокноте. users — словарь
    «id участника → имя», тот же, что и для ленты событий.
    """
    today = datetime.date.today()
    lines = [f"{board['name']} — задачи на {today.strftime('%d.%m.%Y')}", ""]
    for column in columns:
        in_column = [t for t in tasks if t["column_id"] == column["id"]]
        if not in_column:
            continue
        lines.append(f"{column['name']} ({len(in_column)})")
        for task in in_column:
            parts = []
            assignee = users.get(task["assignee_id"])
            parts.append(assignee or "без исполнителя")
            if task["due_date"]:
                parts.append(f"до {task['due_date'][8:10]}.{task['due_date'][5:7]}")
            if task["priority"] in ("high", "medium"):
                parts.append("срочно" if task["priority"] == "high" else "средний")
            lines.append(f"- {task['title']} ({', '.join(parts)})")
        lines.append("")
    if len(lines) <= 2:
        lines.append("Задач пока нет.")
        lines.append("")
    return "\n".join(lines)


def _events_markdown(events, users):
    """Лента событий в Markdown — по дням, свежие сверху."""
    if not events:
        return "Событий пока нет.\n"
    by_day = {}
    for event in events:
        by_day.setdefault(event["created_at"][:10], []).append(event)
    lines = []
    for day in sorted(by_day, reverse=True):
        lines.append(f"## {day}")
        lines.append("")
        for event in by_day[day]:
            who = users.get(event["user_id"], "Кто-то")
            lines.append(f"- {event['created_at'][11:16]} — {event['text']} ({who})")
        lines.append("")
    return "\n".join(lines)


@app.route("/api/boards/<int:board_id>/documents/archive")
def download_project_archive(board_id):
    """Вся документация проекта одним архивом: описание, обновления и файлы."""
    db = get_db()
    board = db.execute("SELECT * FROM boards WHERE id=?", (board_id,)).fetchone()
    if not board:
        abort(404)
    documents = db.execute(
        "SELECT * FROM project_documents WHERE board_id=? ORDER BY created_at, id", (board_id,)
    ).fetchall()
    updates = db.execute(
        "SELECT * FROM project_updates WHERE board_id=? ORDER BY entry_date DESC, id DESC",
        (board_id,),
    ).fetchall()

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "описание.txt",
            board["description"] or f"Проект «{board['name']}». Описание пока не заполнено.",
        )
        changelog = _project_changelog_text(updates)
        archive.writestr("обновления.md", changelog or "Обновлений пока нет.")
        taken = set()
        folder = document_dir(board_id)
        for doc in documents:
            path = os.path.join(folder, doc["stored_name"])
            if not os.path.exists(path):
                continue  # файл могли удалить с диска вручную — не ломаем архив
            # Имя в архиве — только базовое, без пути: иначе файл с именем
            # «../../что-то» распаковался бы вне папки (Zip Slip).
            archive.write(path, f"документы/{unique_archive_name(doc['filename'], taken)}")
    buffer.seek(0)
    return send_file(
        buffer,
        mimetype="application/zip",
        as_attachment=True,
        download_name=f"{safe_document_name(board['name']) or 'проект'}-документация.zip",
    )


# ------------------------------------------------------------
# Публичный доступ по ссылке
# ------------------------------------------------------------
@app.after_request
def public_response_headers(response):
    """Заголовки публичной страницы документации.

    nosniff — чтобы браузер не стал догадываться о типе файла и не
    исполнил его как скрипт; no-store — чтобы закрытая или переименованная
    документация не осталась в кэше браузера или прокси. Остальным
    ответам приложения эти заголовки не нужны, поэтому и не трогаем их.
    """
    if request.path.startswith("/public/"):
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Cache-Control"] = "no-store"
    return response


def _public_project(token):
    """Доска по действующему токену. Выключенный или неверный — как нет."""
    return get_db().execute(
        "SELECT * FROM boards WHERE public_token=? AND docs_public=1", (token,)
    ).fetchone()


def _plural(count, one, few, many):
    """Русские числительные: 1 задача, 2 задачи, 5 задач."""
    tail = count % 100
    if 11 <= tail <= 14:
        return many
    tail %= 10
    if tail == 1:
        return one
    if 2 <= tail <= 4:
        return few
    return many


def _plural_count(count, one, few, many):
    return f"{count} {_plural(count, one, few, many)}"


def project_digest(board_id, days=14):
    """Связный пересказ: что изменилось в проекте за последние дни.

    Лента событий отвечает на вопрос «что случилось», а этот текст — на
    «что изменилось»: одной строкой, как писали бы в письме.
    """
    db = get_db()
    since_dt = datetime.datetime.now() - datetime.timedelta(days=days)
    since = since_dt.isoformat(timespec="seconds")

    created = db.execute(
        "SELECT COUNT(*) c FROM tasks WHERE board_id=? AND created_at>=?", (board_id, since)
    ).fetchone()["c"]
    done = db.execute(
        "SELECT COUNT(*) c FROM tasks t JOIN columns c ON c.id=t.column_id"
        " WHERE t.board_id=? AND c.is_done_state=1 AND t.updated_at>=?",
        (board_id, since),
    ).fetchone()["c"]
    docs = db.execute(
        "SELECT COUNT(*) c FROM project_documents WHERE board_id=? AND created_at>=?",
        (board_id, since),
    ).fetchone()["c"]
    updates = db.execute(
        "SELECT COUNT(*) c FROM project_updates WHERE board_id=? AND created_at>=?",
        (board_id, since),
    ).fetchone()["c"]

    if not any((created, done, docs, updates)):
        return ""

    pieces = []
    if created:
        pieces.append(f"добавлено {_plural_count(created, 'задача', 'задачи', 'задач')}")
    if done:
        pieces.append(f"закрыто {_plural_count(done, 'задача', 'задачи', 'задач')}")
    if updates:
        pieces.append(f"вышло {_plural_count(updates, 'обновление', 'обновления', 'обновлений')}")
    if docs:
        pieces.append(f"приложено {_plural_count(docs, 'документ', 'документа', 'документов')}")
    return f"С {since_dt.strftime('%d.%m')}: " + ", ".join(pieces) + "."


def _format_size(num_bytes):
    if num_bytes < 1024:
        return f"{num_bytes} Б"
    if num_bytes < 1024 * 1024:
        return f"{num_bytes / 1024:.1f} КБ"
    return f"{num_bytes / 1024 / 1024:.1f} МБ"


def _format_entry_date(value):
    """Дата обновления в виде 04.10.2026 — как в интерфейсе приложения."""
    try:
        parsed = datetime.date.fromisoformat(value or "")
    except ValueError:
        return value or ""
    return parsed.strftime("%d.%m.%Y")


@app.route("/public/docs/<token>")
def public_project_docs(token):
    """Страница документации проекта для тех, кому дали ссылку.

    Только чтение: описать, скачать, посмотреть обновления. Всё, что
    приходит из файлов и полей, экранируется — страница отдаётся
    наравне с приложением по тому же origin.
    """
    board = _public_project(token)
    if not board:
        abort(404)
    db = get_db()
    documents = db.execute(
        "SELECT * FROM project_documents WHERE board_id=? ORDER BY created_at, id",
        (board["id"],),
    ).fetchall()
    updates = db.execute(
        "SELECT * FROM project_updates WHERE board_id=? ORDER BY entry_date DESC, id DESC",
        (board["id"],),
    ).fetchall()

    def esc(value):
        return html.escape(value or "", quote=True)

    doc_rows = "".join(
        f"""      <li class="public-doc">
        <span class="public-doc-name">{esc(doc["filename"])}</span>
        <span class="public-doc-meta">{esc(_format_size(doc["size_bytes"]))} · {esc(doc["updated_at"][:10])}</span>
        <a class="public-doc-download" href="/public/docs/{token}/{doc["id"]}/download">скачать</a>
      </li>"""
        for doc in documents
    )
    update_rows = "".join(
        f"""      <li class="public-update">
        <span class="public-update-date">{esc(_format_entry_date(u["entry_date"]))}</span>
        <span class="public-update-title">{esc(u["title"])}</span>
        {f'<p class="public-update-text">{esc(u["text"])}</p>' if u["text"] else ""}
      </li>"""
        for u in updates
    )

    return f"""<!DOCTYPE html>
<html lang="ru" data-theme="retro">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{esc(board["name"])} — документация · QuestLog</title>
<link rel="stylesheet" href="/static/style.css">
</head>
<body class="public-page">
  <main class="public-card">
    <header class="public-card-head">
      <span class="logo-mark">&#9670;</span>
      <h1>{esc(board["name"])}</h1>
      <p class="public-brand">QuestLog · документация проекта</p>
    </header>
    <section class="public-section">
      <h2>Описание</h2>
      <p class="public-desc">{esc(board["description"]) or "Описание пока не заполнено."}</p>
    </section>
    <section class="public-section">
      <h2>Обновления</h2>
      {f'<ul class="public-list">{update_rows}</ul>' if updates else '<p class="public-empty">Обновлений пока нет.</p>'}
    </section>
    <section class="public-section">
      <h2>Документы</h2>
      {f'<ul class="public-list">{doc_rows}</ul>' if documents else '<p class="public-empty">Файлов пока нет.</p>'}
    </section>
    <footer class="public-foot">Страница доступна всем, у кого есть ссылка. Отключить её можно в приложении QuestLog.</footer>
  </main>
</body>
</html>
"""


@app.route("/public/docs/<token>/<int:doc_id>/download")
def public_download_project_document(token, doc_id):
    board = _public_project(token)
    if not board:
        abort(404)
    db = get_db()
    row = db.execute(
        "SELECT * FROM project_documents WHERE id=? AND board_id=?", (doc_id, board["id"])
    ).fetchone()
    if not row:
        abort(404)
    # Всегда как вложение: страница документации и приложение живут на
    # одном origin, поэтому отдавать отсюда «настоящий» HTML нельзя.
    mime = mimetypes.guess_type(row["filename"])[0] or "application/octet-stream"
    return send_from_directory(
        document_dir(board["id"]), row["stored_name"], as_attachment=True,
        download_name=row["filename"], mimetype=mime,
    )

# ============================================================
# Full board state (columns + tasks + users) in one call
# ============================================================
@app.route("/api/state")
def get_state():
    board_id = request.args.get("board_id", type=int)
    db = get_db()
    if not board_id:
        row = db.execute("SELECT id FROM boards ORDER BY id LIMIT 1").fetchone()
        board_id = row["id"] if row else None
    if not board_id:
        return jsonify({"board_id": None, "columns": [], "users": []})

    columns = db.execute(
        "SELECT * FROM columns WHERE board_id=? ORDER BY position", (board_id,)
    ).fetchall()

    result_columns = []
    # Агрегаты времени для карточек: сумма длительностей всех записей
    # и флаг «таймер запущен» (есть незакрытая запись).
    time_stats = {}
    for r in db.execute(
        """SELECT task_id,
                  COALESCE(SUM(duration_seconds), 0) AS total,
                  MAX(CASE WHEN stopped_at IS NULL THEN 1 ELSE 0 END) AS running
           FROM time_entries GROUP BY task_id"""
    ).fetchall():
        time_stats[r["task_id"]] = (r["total"], bool(r["running"]))

    for col in columns:
        tasks = db.execute(
            "SELECT * FROM tasks WHERE column_id=? ORDER BY position", (col["id"],)
        ).fetchall()
        task_list = []
        for t in tasks:
            cc = db.execute(
                "SELECT COUNT(*) c FROM comments WHERE task_id=?", (t["id"],)
            ).fetchone()["c"]
            ac = db.execute(
                "SELECT COUNT(*) c FROM attachments WHERE task_id=?", (t["id"],)
            ).fetchone()["c"]
            st = db.execute(
                "SELECT COUNT(*) total, COALESCE(SUM(done), 0) done FROM subtasks WHERE task_id=?", (t["id"],)
            ).fetchone()
            tspent, trun = time_stats.get(t["id"], (0, False))
            task_list.append(task_dict(t, cc, ac, st["total"], st["done"], tspent, trun))
        result_columns.append(
            {
                "id": col["id"],
                "name": col["name"],
                "position": col["position"],
                "is_done_state": bool(col["is_done_state"]),
                "tasks": task_list,
            }
        )

    users = db.execute("SELECT * FROM users ORDER BY id").fetchall()
    return jsonify(
        {
            "board_id": board_id,
            "columns": result_columns,
            "users": [user_dict(u) for u in users],
        }
    )


# ============================================================
# Columns
# ============================================================
@app.route("/api/columns", methods=["POST"])
def create_column():
    data = request.get_json(force=True)
    board_id = data.get("board_id")
    name = (data.get("name") or "").strip()
    if not board_id or not name:
        return jsonify({"error": "board_id и name обязательны"}), 400
    db = get_db()
    max_pos = db.execute(
        "SELECT COALESCE(MAX(position), -1) m FROM columns WHERE board_id=?", (board_id,)
    ).fetchone()["m"]
    cur = db.execute(
        "INSERT INTO columns (board_id, name, position, is_done_state) VALUES (?,?,?,0)",
        (board_id, name, max_pos + 1),
    )
    db.commit()
    log_event(board_id, "column_created", f"Колонка «{name}» создана")
    db.commit()
    return jsonify({"id": cur.lastrowid, "name": name, "position": max_pos + 1}), 201


@app.route("/api/columns/<int:col_id>", methods=["PUT"])
def rename_column(col_id):
    data = request.get_json(force=True)
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name обязателен"}), 400
    db = get_db()
    db.execute("UPDATE columns SET name=? WHERE id=?", (name, col_id))
    db.commit()
    column = db.execute("SELECT board_id FROM columns WHERE id=?", (col_id,)).fetchone()
    if column:
        log_event(column["board_id"], "column_renamed", f"Колонка переименована в «{name}»")
        db.commit()
    return jsonify({"ok": True})


@app.route("/api/columns/<int:col_id>", methods=["DELETE"])
def delete_column(col_id):
    db = get_db()
    column = db.execute("SELECT board_id, name FROM columns WHERE id=?", (col_id,)).fetchone()
    if not column:
        return jsonify({"error": "Колонка не найдена"}), 404
    board_id = column["board_id"]
    name = column["name"]
    count = db.execute("SELECT COUNT(*) c FROM tasks WHERE column_id=?", (col_id,)).fetchone()["c"]
    if count > 0:
        return jsonify({"error": "Нельзя удалить колонку с задачами. Сначала перенесите их."}), 400
    db.execute("DELETE FROM columns WHERE id=?", (col_id,))
    db.commit()
    log_event(board_id, "column_deleted", f"Колонка «{name}» удалена")
    db.commit()
    return jsonify({"ok": True})


# ============================================================
# Tasks
# ============================================================
@app.route("/api/tasks", methods=["POST"])
def create_task():
    data = request.get_json(force=True)
    board_id = data.get("board_id")
    column_id = data.get("column_id")
    title = (data.get("title") or "").strip()
    if not board_id or not column_id or not title:
        return jsonify({"error": "board_id, column_id, title обязательны"}), 400
    due_date = valid_due_date(data.get("due_date", ""))
    if due_date is None:
        return jsonify({"error": "Некорректная дата срока"}), 400

    db = get_db()
    column = db.execute(
        "SELECT board_id FROM columns WHERE id=?", (column_id,)
    ).fetchone()
    if not column or column["board_id"] != board_id:
        return jsonify({"error": "Колонка не принадлежит указанной доске"}), 400
    max_pos = db.execute(
        "SELECT COALESCE(MAX(position), -1) m FROM tasks WHERE column_id=?", (column_id,)
    ).fetchone()["m"]
    ts = now_iso()
    tags = ",".join([t.strip() for t in (data.get("tags") or []) if t.strip()])
    cur = db.execute(
        """INSERT INTO tasks (board_id, column_id, title, description, priority,
           assignee_id, tags, due_date, position, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            board_id, column_id, title, data.get("description", ""),
            data.get("priority", "normal"), data.get("assignee_id"),
            tags, due_date, max_pos + 1, ts, ts,
        ),
    )
    db.commit()
    row = db.execute("SELECT * FROM tasks WHERE id=?", (cur.lastrowid,)).fetchone()
    log_event(board_id, "task_created", f"Задача «{title}» создана")
    db.commit()
    return jsonify(task_dict(row)), 201


@app.route("/api/tasks/<int:task_id>")
def get_task(task_id):
    db = get_db()
    row = db.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
    if not row:
        abort(404)
    comments = db.execute(
        "SELECT * FROM comments WHERE task_id=? ORDER BY id", (task_id,)
    ).fetchall()
    attachments = db.execute(
        "SELECT * FROM attachments WHERE task_id=? ORDER BY id", (task_id,)
    ).fetchall()
    subtasks = db.execute(
        "SELECT * FROM subtasks WHERE task_id=? ORDER BY position", (task_id,)
    ).fetchall()
    time_entries = db.execute(
        "SELECT * FROM time_entries WHERE task_id=? ORDER BY id", (task_id,)
    ).fetchall()
    done_count = sum(1 for s in subtasks if s["done"])
    time_total = sum(e["duration_seconds"] for e in time_entries)
    time_running = any(e["stopped_at"] is None for e in time_entries)
    result = task_dict(row, len(comments), len(attachments), len(subtasks), done_count, time_total, time_running)
    result["comments"] = [comment_dict(c) for c in comments]
    result["attachments"] = [attachment_dict(a) for a in attachments]
    result["subtasks"] = [subtask_dict(s) for s in subtasks]
    result["time_entries"] = [time_entry_dict(e) for e in time_entries]
    return jsonify(result)


@app.route("/api/tasks/<int:task_id>", methods=["PUT"])
def update_task(task_id):
    data = request.get_json(force=True)
    db = get_db()
    row = db.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
    if not row:
        abort(404)

    fields = {}
    for key in ("title", "description", "priority", "due_date"):
        if key in data:
            fields[key] = data[key]
    if "title" in fields:
        fields["title"] = (fields["title"] or "").strip()
        if not fields["title"]:
            return jsonify({"error": "Название задачи не может быть пустым"}), 400
    if "priority" in fields and fields["priority"] not in ("high", "medium", "normal", "low"):
        return jsonify({"error": "Неизвестный приоритет"}), 400
    if "due_date" in fields:
        checked_due = valid_due_date(fields["due_date"])
        if checked_due is None:
            return jsonify({"error": "Некорректная дата срока"}), 400
        fields["due_date"] = checked_due
    if "assignee_id" in data:
        fields["assignee_id"] = data["assignee_id"]
    if "tags" in data:
        fields["tags"] = ",".join([t.strip() for t in (data["tags"] or []) if t.strip()])

    if fields:
        # Форма задачи отправляет себя целиком, поэтому в ленту попадают только
        # те поля, которые действительно отличаются от сохранённых.
        changed = ", ".join(
            FIELD_LABELS.get(key, key)
            for key, value in fields.items()
            if key != "updated_at" and not same_value(row[key], value)
        )
        fields["updated_at"] = now_iso()
        set_clause = ", ".join(f"{k}=?" for k in fields)
        db.execute(f"UPDATE tasks SET {set_clause} WHERE id=?", (*fields.values(), task_id))
        db.commit()
        if changed:
            log_event(
                row["board_id"], "task_updated",
                f"Задача «{row['title']}»: изменено — {changed}",
            )
            db.commit()

    row = db.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
    return jsonify(task_dict(row))


@app.route("/api/tasks/<int:task_id>", methods=["DELETE"])
def delete_task(task_id):
    db = get_db()
    atts = db.execute("SELECT * FROM attachments WHERE task_id=?", (task_id,)).fetchall()
    row = db.execute("SELECT board_id, title FROM tasks WHERE id=?", (task_id,)).fetchone()
    board_id = row["board_id"] if row else None
    title = row["title"] if row else ""
    for a in atts:
        path = os.path.join(ATTACH_DIR, a["stored_name"])
        if os.path.exists(path):
            os.remove(path)
    db.execute("DELETE FROM tasks WHERE id=?", (task_id,))
    db.commit()
    log_event(board_id, "task_deleted", f"Задача «{title}» удалена")
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/tasks/<int:task_id>/move", methods=["POST"])
def move_task(task_id):
    """Move a task to a (possibly different) column at a given index, reindexing positions."""
    data = request.get_json(force=True)
    new_column_id = data.get("column_id")
    new_index = data.get("position", 0)
    db = get_db()
    task = db.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
    if not task:
        abort(404)
    target_column = db.execute(
        "SELECT board_id FROM columns WHERE id=?", (new_column_id,)
    ).fetchone()
    if not target_column:
        return jsonify({"error": "Колонка не найдена"}), 404
    old_column_id = task["column_id"]
    old_board_id = task["board_id"]
    new_board_id = target_column["board_id"]

    # Pull ordered id list of the destination column, excluding the moving task
    dest_tasks = [
        r["id"] for r in db.execute(
            "SELECT id FROM tasks WHERE column_id=? AND id!=? ORDER BY position",
            (new_column_id, task_id),
        ).fetchall()
    ]
    new_index = max(0, min(new_index, len(dest_tasks)))
    dest_tasks.insert(new_index, task_id)

    db.execute(
        "UPDATE tasks SET board_id=?, column_id=? WHERE id=?",
        (new_board_id, new_column_id, task_id),
    )
    for i, tid in enumerate(dest_tasks):
        db.execute("UPDATE tasks SET position=? WHERE id=?", (i, tid))

    if old_column_id != new_column_id or old_board_id != new_board_id:
        # reindex the source column to close the gap
        src_tasks = [
            r["id"] for r in db.execute(
                "SELECT id FROM tasks WHERE column_id=? ORDER BY position", (old_column_id,)
            ).fetchall()
        ]
        for i, tid in enumerate(src_tasks):
            db.execute("UPDATE tasks SET position=? WHERE id=?", (i, tid))

    db.execute("UPDATE tasks SET updated_at=? WHERE id=?", (now_iso(), task_id))
    db.commit()
    if old_board_id != new_board_id:
        target_board = db.execute("SELECT name FROM boards WHERE id=?", (new_board_id,)).fetchone()
        where = f"на доску «{target_board['name']}»" if target_board else "на другую доску"
        log_event(old_board_id, "task_moved", f"Задача «{task['title']}» перенесена {where}")
    else:
        target = db.execute("SELECT name FROM columns WHERE id=?", (new_column_id,)).fetchone()
        where = f"в «{target['name']}»" if target else "в другую колонку"
        log_event(old_board_id, "task_moved", f"Задача «{task['title']}» перенесена {where}")
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/tasks/bulk-move", methods=["POST"])
def bulk_move_tasks():
    """Move all tasks matching a tag to a target board/column.

    If target_column_id is omitted, columns are mapped by name
    (task's current column name → matching column on target board).
    Falls back to the first non-done column on the target board.
    """
    data = request.get_json(force=True)
    tag = (data.get("tag") or "").strip()
    source_board_id = data.get("source_board_id")
    target_board_id = data.get("target_board_id")
    target_column_id = data.get("target_column_id")
    task_id_filter = data.get("task_id")

    if not source_board_id or not target_board_id:
        return jsonify({"error": "source_board_id и target_board_id обязательны"}), 400
    if not tag and not task_id_filter:
        return jsonify({"error": "tag или task_id обязателен"}), 400

    db = get_db()

    board = db.execute("SELECT id FROM boards WHERE id=?", (target_board_id,)).fetchone()
    if not board:
        return jsonify({"error": "Доска не найдена"}), 404

    source_board = db.execute("SELECT id FROM boards WHERE id=?", (source_board_id,)).fetchone()
    if not source_board:
        return jsonify({"error": "Исходная доска не найдена"}), 404

    target_columns = db.execute(
        "SELECT id, name, is_done_state FROM columns WHERE board_id=? ORDER BY position",
        (target_board_id,),
    ).fetchall()

    if target_column_id:
        column = db.execute(
            "SELECT id FROM columns WHERE id=? AND board_id=?",
            (target_column_id, target_board_id),
        ).fetchone()
        if not column:
            return jsonify({"error": "Колонка не найдена в указанной доске"}), 404
        col_map = {}
        fallback_col_id = target_column_id
    else:
        fallback_col = next(
            (c for c in target_columns if not c["is_done_state"]), target_columns[0]
        )
        fallback_col_id = fallback_col["id"]
        col_map = {c["name"]: c["id"] for c in target_columns}

    if task_id_filter:
        all_tasks = db.execute(
            "SELECT id, column_id FROM tasks WHERE id=? AND board_id=?",
            (task_id_filter, source_board_id),
        ).fetchall()
    else:
        all_tasks = db.execute(
            "SELECT id, column_id FROM tasks WHERE board_id=? AND ',' || tags || ',' LIKE ?",
            (source_board_id, f"%,{tag},%",),
        ).fetchall()

    task_ids = [r["id"] for r in all_tasks]
    source_columns = sorted(set(r["column_id"] for r in all_tasks))

    src_col_names = {}
    for col_id in source_columns:
        row = db.execute("SELECT name FROM columns WHERE id=?", (col_id,)).fetchone()
        if row:
            src_col_names[col_id] = row["name"]

    for task in all_tasks:
        if target_column_id:
            dest_col = target_column_id
        else:
            col_name = src_col_names.get(task["column_id"])
            dest_col = col_map.get(col_name, fallback_col_id) if col_name else fallback_col_id
        db.execute(
            "UPDATE tasks SET board_id=?, column_id=?, updated_at=? WHERE id=?",
            (target_board_id, dest_col, now_iso(), task["id"]),
        )

    for col_id in source_columns:
        src_tasks = [
            r["id"] for r in db.execute(
                "SELECT id FROM tasks WHERE column_id=? ORDER BY position", (col_id,)
            ).fetchall()
        ]
        for i, tid in enumerate(src_tasks):
            db.execute("UPDATE tasks SET position=? WHERE id=?", (i, tid))

    for col in target_columns:
        col_tasks = db.execute(
            "SELECT id FROM tasks WHERE column_id=? ORDER BY position", (col["id"],)
        ).fetchall()
        for i, t in enumerate(col_tasks):
            db.execute("UPDATE tasks SET position=? WHERE id=?", (i, t["id"]))

    db.commit()

    return jsonify({"moved": len(task_ids), "tag": tag, "target_board_id": target_board_id})


# ============================================================
# Comments
# ============================================================
@app.route("/api/tasks/<int:task_id>/comments", methods=["POST"])
def add_comment(task_id):
    data = request.get_json(force=True)
    text = (data.get("text") or "").strip()
    if not text:
        return jsonify({"error": "text обязателен"}), 400
    db = get_db()
    task = db.execute("SELECT id FROM tasks WHERE id=?", (task_id,)).fetchone()
    if not task:
        abort(404)
    cur = db.execute(
        "INSERT INTO comments (task_id, user_id, text, created_at) VALUES (?,?,?,?)",
        (task_id, data.get("user_id"), text, now_iso()),
    )
    db.commit()
    row = db.execute("SELECT * FROM comments WHERE id=?", (cur.lastrowid,)).fetchone()
    return jsonify(comment_dict(row)), 201


@app.route("/api/comments/<int:comment_id>", methods=["PUT"])
def update_comment(comment_id):
    """Редактирование текста комментария."""
    data = request.get_json(force=True)
    text = (data.get("text") or "").strip()
    if not text:
        return jsonify({"error": "text обязателен"}), 400
    db = get_db()
    row = db.execute("SELECT id FROM comments WHERE id=?", (comment_id,)).fetchone()
    if not row:
        return jsonify({"error": "Комментарий не найден"}), 404
    db.execute("UPDATE comments SET text=? WHERE id=?", (text, comment_id))
    db.commit()
    updated = db.execute("SELECT * FROM comments WHERE id=?", (comment_id,)).fetchone()
    return jsonify(comment_dict(updated))


@app.route("/api/comments/<int:comment_id>", methods=["DELETE"])
def delete_comment(comment_id):
    db = get_db()
    db.execute("DELETE FROM comments WHERE id=?", (comment_id,))
    db.commit()
    return jsonify({"ok": True})


# ============================================================
# Attachments
# ============================================================
@app.route("/api/tasks/<int:task_id>/attachments", methods=["POST"])
def upload_attachment(task_id):
    db = get_db()
    task = db.execute("SELECT id FROM tasks WHERE id=?", (task_id,)).fetchone()
    if not task:
        abort(404)
    if "file" not in request.files:
        return jsonify({"error": "Файл не передан"}), 400
    file = request.files["file"]
    if not file.filename:
        return jsonify({"error": "Пустое имя файла"}), 400

    original_name = file.filename
    ext = os.path.splitext(original_name)[1]
    stored_name = f"{uuid.uuid4().hex}{ext}"
    dest_path = os.path.join(ATTACH_DIR, stored_name)
    file.save(dest_path)
    size = os.path.getsize(dest_path)

    cur = db.execute(
        """INSERT INTO attachments (task_id, filename, stored_name, size_bytes, uploaded_at)
           VALUES (?,?,?,?,?)""",
        (task_id, original_name, stored_name, size, now_iso()),
    )
    db.commit()
    row = db.execute("SELECT * FROM attachments WHERE id=?", (cur.lastrowid,)).fetchone()
    return jsonify(attachment_dict(row)), 201


# Типы, которые разрешено отдавать браузеру для показа в лайтбоксе
# (?inline=1), а не только скачиванием. HTML и SVG сюда не входят намеренно:
# встроенные в страницу приложения, они выполнили бы свой скрипт на том же
# origin и получили бы доступ к API.
INLINE_PREVIEW_MIMES = {"application/pdf"}


@app.route("/api/attachments/<int:att_id>/download")
def download_attachment(att_id):
    db = get_db()
    row = db.execute("SELECT * FROM attachments WHERE id=?", (att_id,)).fetchone()
    if not row:
        abort(404)
    mime = mimetypes.guess_type(row["filename"])[0] or "application/octet-stream"
    # ?inline=1 — превью в лайтбоксе: браузер рисует PDF во фрейме только при
    # Content-Disposition: inline, с attachment он молча скачивает файл.
    inline_preview = request.args.get("inline") == "1" and mime in INLINE_PREVIEW_MIMES
    return send_from_directory(
        ATTACH_DIR, row["stored_name"], as_attachment=not inline_preview,
        download_name=row["filename"], mimetype=mime,
    )


@app.route("/api/attachments/<int:att_id>", methods=["DELETE"])
def delete_attachment(att_id):
    db = get_db()
    row = db.execute("SELECT * FROM attachments WHERE id=?", (att_id,)).fetchone()
    if row:
        path = os.path.join(ATTACH_DIR, row["stored_name"])
        if os.path.exists(path):
            os.remove(path)
        db.execute("DELETE FROM attachments WHERE id=?", (att_id,))
        db.commit()
    return jsonify({"ok": True})


# ============================================================
# Subtasks
# ============================================================
@app.route("/api/tasks/<int:task_id>/subtasks", methods=["POST"])
def create_subtask(task_id):
    data = request.get_json(force=True)
    title = (data.get("title") or "").strip()
    if not title:
        return jsonify({"error": "title обязателен"}), 400
    db = get_db()
    task = db.execute("SELECT id FROM tasks WHERE id=?", (task_id,)).fetchone()
    if not task:
        abort(404)
    max_pos = db.execute(
        "SELECT COALESCE(MAX(position), -1) m FROM subtasks WHERE task_id=?", (task_id,)
    ).fetchone()["m"]
    cur = db.execute(
        "INSERT INTO subtasks (task_id, title, done, position, created_at) VALUES (?,?,0,?,?)",
        (task_id, title, max_pos + 1, now_iso()),
    )
    db.commit()
    row = db.execute("SELECT * FROM subtasks WHERE id=?", (cur.lastrowid,)).fetchone()
    return jsonify(subtask_dict(row)), 201


@app.route("/api/subtasks/<int:subtask_id>", methods=["PUT"])
def update_subtask(subtask_id):
    data = request.get_json(force=True)
    db = get_db()
    row = db.execute("SELECT * FROM subtasks WHERE id=?", (subtask_id,)).fetchone()
    if not row:
        abort(404)
    fields = {}
    if "title" in data:
        title = (data["title"] or "").strip()
        if not title:
            return jsonify({"error": "title не может быть пустым"}), 400
        fields["title"] = title
    if "done" in data:
        fields["done"] = 1 if data["done"] else 0
    if fields:
        set_clause = ", ".join(f"{k}=?" for k in fields)
        db.execute(f"UPDATE subtasks SET {set_clause} WHERE id=?", (*fields.values(), subtask_id))
        db.commit()
    row = db.execute("SELECT * FROM subtasks WHERE id=?", (subtask_id,)).fetchone()
    return jsonify(subtask_dict(row))


@app.route("/api/subtasks/<int:subtask_id>", methods=["DELETE"])
def delete_subtask(subtask_id):
    db = get_db()
    db.execute("DELETE FROM subtasks WHERE id=?", (subtask_id,))
    db.commit()
    return jsonify({"ok": True})


# ============================================================
# Time tracking (тайм-трекинг на задачах)
# ============================================================
def _elapsed_seconds(started_at_iso, end=None):
    started = datetime.datetime.fromisoformat(started_at_iso)
    end = datetime.datetime.now() if end is None else end
    return max(0, int((end - started).total_seconds()))


@app.route("/api/tasks/<int:task_id>/timer/start", methods=["POST"])
def start_timer(task_id):
    """Запустить таймер на задаче. У каждого участника может быть
    только один активный таймер — чужие автоматически останавливаются."""
    data = request.get_json(force=True)
    user_id = data.get("user_id")
    db = get_db()
    task = db.execute("SELECT id FROM tasks WHERE id=?", (task_id,)).fetchone()
    if not task:
        abort(404)

    now = now_iso()
    # Останавливаем другие запущенные таймеры этого пользователя
    running = db.execute(
        "SELECT id, started_at FROM time_entries WHERE user_id IS ? AND stopped_at IS NULL",
        (user_id,),
    ).fetchall()
    for r in running:
        db.execute(
            "UPDATE time_entries SET stopped_at=?, duration_seconds=? WHERE id=?",
            (now, _elapsed_seconds(r["started_at"]), r["id"]),
        )

    cur = db.execute(
        """INSERT INTO time_entries (task_id, user_id, description, started_at, stopped_at, duration_seconds, created_at)
           VALUES (?,?,?,?,NULL,0,?)""",
        (task_id, user_id, "", now, now),
    )
    db.commit()
    row = db.execute("SELECT * FROM time_entries WHERE id=?", (cur.lastrowid,)).fetchone()
    return jsonify(time_entry_dict(row)), 201


@app.route("/api/tasks/<int:task_id>/timer/stop", methods=["POST"])
def stop_timer(task_id):
    """Остановить активный таймер задачи и зафиксировать длительность."""
    db = get_db()
    row = db.execute(
        "SELECT id FROM time_entries WHERE task_id=? AND stopped_at IS NULL ORDER BY id LIMIT 1",
        (task_id,),
    ).fetchone()
    if not row:
        return jsonify({"error": "На задаче нет запущенного таймера"}), 404

    now = datetime.datetime.now()
    entry = db.execute("SELECT * FROM time_entries WHERE id=?", (row["id"],)).fetchone()
    duration = _elapsed_seconds(entry["started_at"], now)
    db.execute(
        "UPDATE time_entries SET stopped_at=?, duration_seconds=? WHERE id=?",
        (now.isoformat(timespec="seconds"), duration, row["id"]),
    )
    db.commit()
    entry = db.execute("SELECT * FROM time_entries WHERE id=?", (row["id"],)).fetchone()
    return jsonify(time_entry_dict(entry))


@app.route("/api/time-entries/<int:entry_id>", methods=["DELETE"])
def delete_time_entry(entry_id):
    db = get_db()
    db.execute("DELETE FROM time_entries WHERE id=?", (entry_id,))
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/time-entries/<int:entry_id>", methods=["PUT"])
def update_time_entry(entry_id):
    """Ручное редактирование записи времени (длительность, описание, даты)."""
    data = request.get_json(force=True)
    db = get_db()
    row = db.execute("SELECT * FROM time_entries WHERE id=?", (entry_id,)).fetchone()
    if not row:
        abort(404)

    fields = {}
    if "description" in data:
        fields["description"] = data["description"] or ""
    if "duration_seconds" in data:
        fields["duration_seconds"] = max(0, int(data["duration_seconds"]))
    if "started_at" in data and data["started_at"]:
        fields["started_at"] = data["started_at"]
    if "stopped_at" in data:
        fields["stopped_at"] = data["stopped_at"] or None

    if fields:
        set_clause = ", ".join(f"{k}=?" for k in fields)
        db.execute(f"UPDATE time_entries SET {set_clause} WHERE id=?", (*fields.values(), entry_id))
        db.commit()

    row = db.execute("SELECT * FROM time_entries WHERE id=?", (entry_id,)).fetchone()
    return jsonify(time_entry_dict(row))


# ============================================================
# Users (participants) — ready for team usage later
# ============================================================
@app.route("/api/users", methods=["GET"])
def list_users():
    db = get_db()
    rows = db.execute("SELECT * FROM users ORDER BY id").fetchall()
    return jsonify([user_dict(r) for r in rows])


@app.route("/api/users", methods=["POST"])
def create_user():
    data = request.get_json(force=True)
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "Имя обязательно"}), 400
    db = get_db()
    count = db.execute("SELECT COUNT(*) c FROM users").fetchone()["c"]
    color = data.get("color") or DEFAULT_COLORS[count % len(DEFAULT_COLORS)]
    cur = db.execute(
        "INSERT INTO users (name, color, created_at) VALUES (?,?,?)", (name, color, now_iso())
    )
    db.commit()
    row = db.execute("SELECT * FROM users WHERE id=?", (cur.lastrowid,)).fetchone()
    return jsonify(user_dict(row)), 201


@app.route("/api/users/<int:user_id>", methods=["DELETE"])
def delete_user(user_id):
    db = get_db()
    db.execute("UPDATE tasks SET assignee_id=NULL WHERE assignee_id=?", (user_id,))
    db.execute("UPDATE comments SET user_id=NULL WHERE user_id=?", (user_id,))
    db.execute("UPDATE project_updates SET user_id=NULL WHERE user_id=?", (user_id,))
    db.execute("DELETE FROM users WHERE id=?", (user_id,))
    db.commit()
    return jsonify({"ok": True})


# ============================================================
# Entrypoint
# ============================================================
if __name__ == "__main__":
    init_db()
    port = int(os.environ.get("TASKBOARD_PORT", "8420"))
    print(f"QuestLog запущен: http://127.0.0.1:{port}")
    print(f"Данные хранятся в: {APP_DIR}")
    app.run(host="127.0.0.1", port=port, debug=False)
