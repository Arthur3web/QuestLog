#!/usr/bin/env python3
"""
QuestLog — локальная платформа управления задачами (в стиле Linear).
Работает одинаково на Windows и Linux: Python + Flask + SQLite, открывается в браузере.

Запуск:
    python server.py
Затем открыть http://127.0.0.1:8420 в браузере.

Все данные хранятся локально в ~/.questlog/taskboard.db
Вложения — в ~/.questlog/attachments/
"""
import os
import sqlite3
import uuid
import mimetypes
import datetime
from flask import Flask, request, jsonify, send_from_directory, g, abort
from flask_cors import CORS

# ============================================================
# Paths & config
# ============================================================
_OLD_APP_DIR = os.path.join(os.path.expanduser("~"), ".taskboard")  # имя папки до переименования проекта в QuestLog
APP_DIR = os.path.join(os.path.expanduser("~"), ".questlog")
DB_PATH = os.path.join(APP_DIR, "taskboard.db")
ATTACH_DIR = os.path.join(APP_DIR, "attachments")
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
MAX_UPLOAD_MB = 25

if os.path.isdir(_OLD_APP_DIR) and not os.path.exists(APP_DIR):
    # Одноразовая миграция данных из старой папки ~/.taskboard в ~/.questlog.
    os.rename(_OLD_APP_DIR, APP_DIR)

os.makedirs(APP_DIR, exist_ok=True)
os.makedirs(ATTACH_DIR, exist_ok=True)

app = Flask(__name__, static_folder=None)
CORS(app)
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_MB * 1024 * 1024

DEFAULT_COLUMNS = ["Бэклог", "Todo", "In Progress", "Done", "Cancelled"]
DEFAULT_COLORS = ["#6E56CF", "#E8590C", "#2F9E44", "#1971C2", "#C2255C", "#0CA678"]


def now_iso():
    return datetime.datetime.now().isoformat(timespec="seconds")


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
        """
    )
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
    """Переименование доски."""
    data = request.get_json(force=True)
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "Название доски обязательно"}), 400
    db = get_db()
    board = db.execute("SELECT id FROM boards WHERE id=?", (board_id,)).fetchone()
    if not board:
        return jsonify({"error": "Доска не найдена"}), 404
    db.execute("UPDATE boards SET name=? WHERE id=?", (name, board_id))
    db.commit()
    return jsonify({"id": board_id, "name": name})

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
    return jsonify({"ok": True})


@app.route("/api/columns/<int:col_id>", methods=["DELETE"])
def delete_column(col_id):
    db = get_db()
    count = db.execute("SELECT COUNT(*) c FROM tasks WHERE column_id=?", (col_id,)).fetchone()["c"]
    if count > 0:
        return jsonify({"error": "Нельзя удалить колонку с задачами. Сначала перенесите их."}), 400
    db.execute("DELETE FROM columns WHERE id=?", (col_id,))
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
        fields["updated_at"] = now_iso()
        set_clause = ", ".join(f"{k}=?" for k in fields)
        db.execute(f"UPDATE tasks SET {set_clause} WHERE id=?", (*fields.values(), task_id))
        db.commit()

    row = db.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
    return jsonify(task_dict(row))


@app.route("/api/tasks/<int:task_id>", methods=["DELETE"])
def delete_task(task_id):
    db = get_db()
    atts = db.execute("SELECT * FROM attachments WHERE task_id=?", (task_id,)).fetchall()
    for a in atts:
        path = os.path.join(ATTACH_DIR, a["stored_name"])
        if os.path.exists(path):
            os.remove(path)
    db.execute("DELETE FROM tasks WHERE id=?", (task_id,))
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
