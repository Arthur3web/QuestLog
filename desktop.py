#!/usr/bin/env python3
"""
QuestLog — desktop-режим.

Оборачивает локальный Flask-сервер (server.py) в нативное приложение:
  - иконка в системном трее (pystray);
  - окно приложения (pywebview) вместо вкладки браузера;
  - закрытие окна сворачивает приложение в трей, выход — из меню трея;
  - автозапуск при входе в систему включается прямо из меню трея;
  - повторный запуск не создаёт вторую копию, а поднимает существующее окно.

Запуск:
    python desktop.py            # окно открывается сразу
    python desktop.py --hidden   # стартовать свернутым в трей

Данные по-прежнему в ~/.questlog/.
"""
import argparse
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.request

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
HOST = "127.0.0.1"
BASE_PORT = 8420
MAX_PORT_TRIES = 30

sys.path.insert(0, BASE_DIR)

import server  # noqa: E402  (импортирует Flask-приложение без запуска; заодно создаёт/мигрирует APP_DIR)
from flask import jsonify  # noqa: E402

APP_DIR = server.APP_DIR
PORT_FILE = os.path.join(APP_DIR, "desktop_port.txt")

window = None          # pywebview.Window
_icon = None           # pystray.Icon
_quitting = False
_tray_ok = False


# ============================================================
# Extra route: second launch raises the existing window
# ============================================================
def show_window():
    w = globals().get("window")
    if w is None:
        return False
    try:
        w.show()
        try:
            w.evaluate_js("window.focus()")
        except Exception:
            pass
        return True
    except Exception:
        return False


@server.app.route("/focus", methods=["POST"])
def _focus_route():
    return jsonify({"ok": show_window()})


# ============================================================
# Port management (base 8420, then +1…+30; reuse live instance)
# ============================================================
def port_busy(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        return s.connect_ex((HOST, port)) == 0


def health_ok(port):
    try:
        with urllib.request.urlopen(f"http://{HOST}:{port}/api/health", timeout=1.5) as r:
            return r.status == 200
    except Exception:
        return False


def read_saved_port():
    try:
        with open(PORT_FILE, "r", encoding="utf-8") as f:
            return int(f.read().strip())
    except Exception:
        return None


def save_port(port):
    try:
        with open(PORT_FILE, "w", encoding="utf-8") as f:
            f.write(str(port))
    except Exception:
        pass


def acquire_port():
    """Return (port, reused_existing_instance)."""
    saved = read_saved_port()
    order = ([saved] if saved is not None else []) + [
        BASE_PORT + i for i in range(MAX_PORT_TRIES)
    ]
    seen, candidates = set(), []
    for p in order:
        if p not in seen:
            seen.add(p)
            candidates.append(p)

    for p in candidates:
        if not port_busy(p):
            return p, False
        if health_ok(p):
            return p, True
    raise RuntimeError(
        f"Не найден свободный порт в диапазоне {BASE_PORT}–{BASE_PORT + MAX_PORT_TRIES - 1}"
    )


def start_server(port):
    def run():
        try:
            import logging
            logging.getLogger("werkzeug").setLevel(logging.ERROR)
            try:
                import waitress
                waitress.serve(server.app, host=HOST, port=port, threads=8)
            except ImportError:
                from werkzeug.serving import make_server
                make_server(HOST, port, server.app, threaded=True).serve_forever()
        except Exception as e:  # pragma: no cover
            print(f"[QuestLog] Ошибка сервера: {e}", file=sys.stderr)

    t = threading.Thread(target=run, name="taskboard-server", daemon=True)
    t.start()


# ============================================================
# Tray icon
# ============================================================
def make_icon_image():
    from PIL import Image, ImageDraw

    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.polygon([(32, 3), (61, 32), (32, 61), (3, 32)], fill=(91, 91, 214, 255))
    d.polygon([(32, 13), (51, 32), (32, 51), (13, 32)], fill=(18, 19, 24, 255))
    d.polygon([(32, 24), (40, 32), (32, 40), (24, 32)], fill=(201, 169, 106, 255))
    return img


def on_show(*_):
    show_window()


def on_new_task(*_):
    if show_window():
        try:
            window.evaluate_js(
                "window.TaskBoard && window.TaskBoard.openQuickAdd"
                " && window.TaskBoard.openQuickAdd()"
            )
        except Exception:
            pass


def on_open_data_folder(*_):
    try:
        if os.name == "nt":
            os.startfile(APP_DIR)  # noqa: S606
        elif sys.platform == "darwin":
            subprocess.call(["open", APP_DIR])
        else:
            subprocess.call(["xdg-open", APP_DIR])
    except Exception:
        pass


def on_quit(*_):
    global _quitting
    _quitting = True
    try:
        if window:
            window.destroy()
    except Exception:
        pass
    if _icon:
        try:
            _icon.stop()
        except Exception:
            pass


def setup_tray():
    global _tray_ok, _icon
    try:
        import pystray

        menu = pystray.Menu(
            pystray.MenuItem("Открыть QuestLog", on_show, default=True),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Новая задача", on_new_task),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem(
                "Запускать при входе в систему",
                on_toggle_autostart,
                checked=lambda *_: autostart_enabled(),
            ),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Папка с данными", on_open_data_folder),
            pystray.MenuItem("Выход", on_quit),
        )
        icon = pystray.Icon("TaskBoard", make_icon_image(), "QuestLog", menu)
        _icon = icon
        t = threading.Thread(target=icon.run, name="taskboard-tray", daemon=True)
        t.start()
        t.join(2.0)
        if t.is_alive():
            _tray_ok = True
        else:
            print("[QuestLog] Трей недоступен — приложение работает без иконки.",
                  file=sys.stderr)
    except Exception as e:
        print(f"[QuestLog] Трей недоступен ({e}) — приложение работает без иконки.",
              file=sys.stderr)


# ============================================================
# Autostart (per-OS)
# ============================================================
def autostart_dir():
    if os.name == "nt":
        return os.path.join(
            os.environ.get("APPDATA", os.path.expanduser("~")),
            "Microsoft", "Windows", "Start Menu", "Programs", "Startup",
        )
    return os.path.join(os.path.expanduser("~"), ".config", "autostart")


def _launcher_command(hidden):
    py = sys.executable
    if os.name == "nt":
        pyw = os.path.join(os.path.dirname(py), "pythonw.exe")
        if os.path.exists(pyw):
            py = pyw
    script = os.path.join(BASE_DIR, "desktop.py")
    args = [py, script] + (["--hidden"] if hidden else [])
    if os.name == "nt":
        import subprocess as _sp
        return _sp.list2cmdline(args)
    return " ".join(f'"{a}"' for a in args)


def autostart_enabled():
    names = ("TaskBoard.lnk", "TaskBoard.bat") if os.name == "nt" else ("taskboard.desktop",)
    return any(os.path.exists(os.path.join(autostart_dir(), n)) for n in names)


def set_autostart(enable):
    d = autostart_dir()
    os.makedirs(d, exist_ok=True)

    if not enable:
        for n in ("TaskBoard.lnk", "TaskBoard.bat", "taskboard.desktop"):
            p = os.path.join(d, n)
            if os.path.exists(p):
                try:
                    os.remove(p)
                except OSError:
                    pass
        return

    if os.name == "nt":
        try:
            from win32com.client import Dispatch  # pywin32, если установлен
            py = sys.executable
            pyw = os.path.join(os.path.dirname(py), "pythonw.exe")
            if os.path.exists(pyw):
                py = pyw
            shell = Dispatch("WScript.Shell")
            lnk = shell.CreateShortCut(os.path.join(d, "TaskBoard.lnk"))
            lnk.Target = py
            lnk.Arguments = f'"{os.path.join(BASE_DIR, "desktop.py")}" --hidden'
            lnk.WorkingDirectory = BASE_DIR
            lnk.save()
            return
        except Exception:
            pass
        # Fallback без pywin32: .bat в папке автозагрузки
        bat = os.path.join(d, "TaskBoard.bat")
        with open(bat, "w", encoding="ascii") as f:
            f.write('@echo off\r\nstart "" ' + _launcher_command(True) + "\r\n")
    else:
        content = (
            "[Desktop Entry]\n"
            "Type=Application\n"
            "Name=QuestLog\n"
            "Exec=" + _launcher_command(True) + "\n"
            "Terminal=false\n"
            "X-GNOME-Autostart-enabled=true\n"
            "Categories=Office;ProjectManagement;\n"
        )
        p = os.path.join(d, "taskboard.desktop")
        with open(p, "w", encoding="utf-8") as f:
            f.write(content)
        try:
            os.chmod(p, 0o755)
        except OSError:
            pass


def on_toggle_autostart(*_):
    try:
        set_autostart(not autostart_enabled())
    except Exception as e:
        print(f"[QuestLog] Не удалось изменить автозапуск: {e}", file=sys.stderr)


# ============================================================
# Window & lifecycle
# ============================================================
def on_window_closing(*_):
    """Крестик окна должен только сворачивать в трей — полный выход
    только через пункт «Выход» в меню трея (on_quit), который сначала
    выставляет _quitting и сам вызывает window.destroy()."""
    if _quitting:
        return True  # даём окну закрыться по-настоящему при выходе из трея
    if _tray_ok:
        try:
            window.hide()
        except Exception:
            pass
        return False  # отменяем реальное закрытие окна
    return True  # трея нет — без него скрытое окно было бы недостижимо


def stop_all():
    global _quitting
    _quitting = True
    try:
        if window:
            window.destroy()
    except Exception:
        pass
    if _icon:
        try:
            _icon.stop()
        except Exception:
            pass


def run_ui(port, start_hidden):
    global window
    import webview

    url = f"http://{HOST}:{port}/"
    window = webview.create_window(
        "QuestLog",
        url,
        width=1280,
        height=800,
        min_size=(940, 600),
        background_color="#221912",
        hidden=start_hidden,
    )
    window.events.closing += on_window_closing
    setup_tray()

    if start_hidden and not _tray_ok:
        # Без трея скрытое окно стало бы недостижимым — показываем.
        try:
            window.show()
        except Exception:
            pass

    try:
        webview.start(private_mode=False)  # сохраняет localStorage между запусками
    finally:
        if _icon:
            try:
                _icon.stop()
            except Exception:
                pass


def main():
    ap = argparse.ArgumentParser(description="QuestLog desktop (tray) launcher")
    ap.add_argument("--hidden", action="store_true", help="start minimized to tray")
    args = ap.parse_args()

    server.init_db()
    port, reused = acquire_port()

    if reused:
        # Уже работает другой экземпляр — просто поднимаем его окно.
        try:
            req = urllib.request.Request(
                f"http://{HOST}:{port}/focus",
                data=b"{}",
                headers={"Content-Type": "application/json"},
            )
            urllib.request.urlopen(req, timeout=2)
        except Exception:
            pass
        print("[QuestLog] уже запущен — окно поднято.")
        return

    save_port(port)
    start_server(port)
    for _ in range(50):  # ждём готовности сервера до 5 секунд
        if health_ok(port):
            break
        time.sleep(0.1)

    run_ui(port, args.hidden)


if __name__ == "__main__":
    main()
