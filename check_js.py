#!/usr/bin/env python3
"""Проверка синтаксиса JS-модулей фронтенда.

Ловит ровно тот класс ошибок, из-за которого доска однажды перестала
открываться: опечатка в одном модуле (лишняя фигурная скобка, незакрытый
шаблон) роняет весь граф зависимостей, а браузер молчит — обработчик
DOMContentLoaded не сообщает о reject от async-функции.

Запуск:
    python check_js.py                  # проверить синтаксис
    python check_js.py --install-hooks  # поставить pre-commit хук
Без флагов скрипт только читает файлы и зовёт node --check — ничего не
меняет. Флаг --install-hooks копирует scripts/pre-commit в .git/hooks/,
чтобы та же проверка шла автоматически перед каждым коммитом.

Если node не найден, проверка пропускается с кодом 0, чтобы не блокировать
работу на машинах без Node.js.
"""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
JS_ROOT = ROOT / "static" / "js"
HOOK_SRC = ROOT / "scripts" / "pre-commit"
HOOK_DST = ROOT / ".git" / "hooks" / "pre-commit"


def install_hooks() -> int:
    """Копирует pre-commit хук в .git/hooks.

    Вызывается из run.bat / run.sh / run_desktop.* при старте — так хук
    появляется и на новой машине, без ручной команды из README.
    """
    if not (ROOT / ".git").is_dir():
        print("check_js: .git не найден — установка хука пропущена.")
        return 0
    if not HOOK_SRC.exists():
        print("check_js: не найден scripts/pre-commit — хук не установлен.")
        return 0
    HOOK_DST.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(HOOK_SRC, HOOK_DST)

    # Git в Windows обходится без бита выполнения, но в POSIX-системах без
    # него хук молча игнорируется — поэтому ставим.
    try:
        HOOK_DST.chmod(0o755)
    except OSError:
        pass
    print("check_js: pre-commit хук установлен -> .git/hooks/pre-commit")
    return 0

def find_node() -> str | None:
    """node.exe может отсутствовать в PATH (типично для Windows)."""
    for name in ("node", "node.exe"):
        found = shutil.which(name)
        if found:
            return found
    # стандартные места установки на Windows
    candidates = [
        Path(r"C:\Program Files\nodejs\node.exe"),
        Path.home() / "AppData" / "Local" / "Programs" / "nodejs" / "node.exe",
    ]
    for c in candidates:
        if c.exists():
            return str(c)
    return None


def js_files() -> list[Path]:
    if not JS_ROOT.exists():
        return []
    return sorted(p for p in JS_ROOT.rglob("*.js") if p.is_file())


def check(node: str, path: Path) -> str | None:
    """Возвращает текст ошибки или None, если файл валиден."""
    src = path.read_text(encoding="utf-8")
    proc = subprocess.run(
        [node, "--input-type=module", "--check"],
        input=src,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if proc.returncode == 0:
        return None
    first_line = next(
        (ln for ln in (proc.stderr or "").splitlines() if ln.strip()),
        "SyntaxError",
    )
    return first_line.strip()


def main() -> int:
    if "--install-hooks" in sys.argv:
        return install_hooks()

    node = find_node()
    if node is None:
        print("check_js: node не найден — проверка синтаксиса пропущена.")
        return 0

    files = js_files()
    if not files:
        print(f"check_js: JS-файлов не найдено в {JS_ROOT}")
        return 0

    failures: list[tuple[Path, str]] = []
    for f in files:
        err = check(node, f)
        if err:
            failures.append((f, err))

    if failures:
        print(f"check_js: найдено ошибок синтаксиса — {len(failures)} "
              f"из {len(files)} файлов:\n")
        for f, err in failures:
            rel = f.relative_to(ROOT)
            print(f"  [FAIL] {rel}")
            print(f"         {err}")
        print("\nДоска не откроется, пока эти файлы не исправлены.")
        return 1

    print(f"check_js: OK — {len(files)} файлов, ошибок синтаксиса нет.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
