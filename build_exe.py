#!/usr/bin/env python3
"""
Сборка QuestLog в один файл.

Зачем: сейчас запуск требует Python и pip — это главный барьер для всех,
кроме разработчиков. Один файл запускается двойным кликом и содержит
всё нужное: сервер, интерфейс и зависимости.

Запуск:
    pip install -r requirements.txt pyinstaller
    python build_exe.py

Результат:
    dist/QuestLog[.exe]     — приложение (Windows) или дистрибутив (Linux)
    dist/QuestLog-portable/ — папка с .exe и данными (Linux: тарвас внутри)

Что попадает внутрь:
    static/    — интерфейс и стили (server.py ищет их через resource_path)
    server.py, desktop.py — сама логика

Что НЕ попадает (и не надо): пользовательские данные лежат в ~/.questlog
и собранный файл к ним отношения не имеет — резервная копия по-прежнему
это папка .questlog.
"""
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
APP_NAME = "QuestLog"
ENTRY = os.path.join(ROOT, "desktop.py")


def fail(message):
    print(f"build_exe: {message}")
    sys.exit(1)


def main():
    if not os.path.exists(ENTRY):
        fail(f"не найден {ENTRY}")

    try:
        import PyInstaller  # noqa: F401
    except ImportError:
        fail(
            "не установлен PyInstaller.\n"
            "        Установите его: pip install pyinstaller\n"
            "        (или вместе со всеми зависимостями: "
            "pip install -r requirements.txt pyinstaller)"
        )

    for stale in ("build", "QuestLog.spec"):
        path = os.path.join(ROOT, stale)
        if os.path.isdir(path):
            shutil.rmtree(path, ignore_errors=True)
        elif os.path.exists(path):
            os.remove(path)

    # hidden-import: waitress нужен desktop.py, но статический анализ
    # PyInstaller его не находит — он импортируется внутри функции.
    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm",
        "--onefile",
        # Без консоли: приложение живёт в трее и окне, отдельное окно
        # консоли пользователю не нужно.
        "--windowed",
        "--name", APP_NAME,
        "--add-data", f"{os.path.join(ROOT, 'static')}{os.pathsep}static",
        "--hidden-import", "waitress",
        "--collect-submodules", "waitress",
        ENTRY,
    ]
    print("build_exe: " + " ".join(cmd[:6]) + " …")
    result = subprocess.run(cmd, cwd=ROOT)
    if result.returncode != 0:
        fail("PyInstaller завершился с ошибкой (см. вывод выше)")

    binary = APP_NAME + (".exe" if os.name == "nt" else "")
    built = os.path.join(ROOT, "dist", binary)
    if not os.path.exists(built):
        fail(f"сборка прошла, но {built} не найден")

    size_mb = os.path.getsize(built) / 1024 / 1024
    print()
    print(f"build_exe: готово — {built} ({size_mb:.1f} МБ)")
    print("build_exe: данные приложения по-прежнему в ~/.questlog, "
          "резервная копия — это папка.")


if __name__ == "__main__":
    main()