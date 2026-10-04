#!/usr/bin/env python3
"""
Проверка собранного .exe: то, что должно оказаться внутри.

Зачем: номер версии и статика попадают в сборку как данные, и оба могут
молча потеряться. Без файла VERSION подвал показывает пустую версию, а
приложение перестаёт предлагать обновления; без статики приложение
открывается со старым или вовсе без интерфейса. Ни то, ни другое не
падает при сборке — ошибка обнаруживается у человека, уже установившего
себе не то.

Проверяем не вывод таблицы PyInstaller, а сам архив: разбор текста на
стороне shell — это как раз тот способ, на котором проверка молча
ломается (Unicode в PowerShell, кодировки, локаль запуска).

Запуск:
    python scripts/verify_build.py                       # dist/QuestLog.exe
    python scripts/verify_build.py --exe path/to/file.exe
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from console_out import use_utf8  # noqa: E402  — соседний модуль

# Метки, которые обязаны быть в собранной статике. Берём свежие правки
# интерфейса: если сборка старше их появления, значит, её не пересобрали.
MARKERS = {
    "static\\style.css": ["doc-rename-hint", "toast-in"],
    "static\\js\\ui\\main.js": ["showAppVersion"],
    "static\\js\\core\\icons.js": ["check:"],
}


def fail(message):
    print(f"verify_build: {message}", file=sys.stderr)
    sys.exit(1)


def find(reader, wanted):
    """Найти запись в архиве: на Windows разделитель обратный слэш."""
    for name in reader.toc:
        if name.replace("/", "\\") == wanted:
            return name
    return ""


def main():
    use_utf8()
    ap = argparse.ArgumentParser(description="Проверка содержимого собранного .exe")
    ap.add_argument("--exe", default=str(ROOT / "dist" / "QuestLog.exe"))
    ap.add_argument("--version", default="", help="ожидаемый номер версии")
    args = ap.parse_args()

    exe = Path(args.exe)
    if not exe.exists():
        fail(f"нет файла {exe}")

    try:
        from PyInstaller.archive.readers import CArchiveReader
    except ImportError as exc:
        fail(f"нужен PyInstaller для проверки сборки: {exc}")

    try:
        reader = CArchiveReader(str(exe))
    except Exception as exc:
        fail(f"не читается архив сборки: {exc}")

    version = (args.version or (ROOT / "VERSION").read_text(encoding="utf-8").strip())
    entry = find(reader, "VERSION")
    if not entry:
        fail("внутри сборки нет файла VERSION — версия в подвале будет пустой")
    packed = reader.extract(entry)
    if isinstance(packed, bytes):
        packed = packed.decode("utf-8", "replace")
    packed = packed.strip()
    if packed != version:
        fail(f"внутри сборки версия {packed}, а в файле VERSION — {version}")
    print(f"verify_build: версия {packed} на месте")

    for wanted, markers in MARKERS.items():
        entry = find(reader, wanted)
        if not entry:
            fail(f"внутри сборки нет {wanted} — интерфейс будет неполным")
        data = reader.extract(entry)
        if isinstance(data, bytes):
            data = data.decode("utf-8", "replace")
        missing = [marker for marker in markers if marker not in data]
        if missing:
            fail(f"в собранном {wanted} нет свежих правок: {', '.join(missing)} — "
                 "сборка старше изменений интерфейса, её надо пересобрать")
        print(f"verify_build: {wanted} актуален ({', '.join(markers)})")

    print(f"verify_build: {exe.name} в порядке — {exe.stat().st_size / 1024 / 1024:.1f} МБ")


if __name__ == "__main__":
    main()
