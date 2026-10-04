#!/usr/bin/env python3
"""
Проверка, что номер версии в теге совпадает с файлом VERSION.

Зачем: приложение сравнивает версию из подвала с номером последнего
релиза на GitHub. Расхождение не ломает программу — она просто перестаёт
предлагать обновление или, наоборот, предлагает переустановиться на ту же
версию. Ошибка тихая, поэтому дешевле проверить до публикации.

Запуск:
    python scripts/check_release_tag.py v1.0.1     # перед пушем тега
    python scripts/check_release_tag.py            # без аргумента: v + VERSION
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from console_out import use_utf8  # noqa: E402  — соседний модуль


def fail(message):
    print(f"check_release_tag: {message}", file=sys.stderr)
    sys.exit(1)


def main():
    use_utf8()

    if not (ROOT / "VERSION").exists():
        fail("нет файла VERSION — нечего выпускать")

    version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    if not version:
        fail("файл VERSION пуст")

    tag = sys.argv[1].strip() if len(sys.argv) > 1 else f"v{version}"
    # Приложение срезает букву «v» и сравнивает цифры, поэтому именно такая
    # проверка отражает то, что увидит пользователь в подвале.
    if tag.lstrip("vV") != version:
        fail(f"тег {tag} и файл VERSION ({version}) расходятся — "
             "приложение не увидит это обновление")

    print(f"check_release_tag: {tag} — версия {version}")


if __name__ == "__main__":
    main()
