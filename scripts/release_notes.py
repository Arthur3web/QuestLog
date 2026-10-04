#!/usr/bin/env python3
"""
Текст релиза для GitHub Releases.

Зачем отдельный скрипт: в заметках к релизу нужны вещи, которые руками
легко забыть — номер версии из одного источника, прямая ссылка на файл,
контрольная сумма собранного .exe и предупреждение про неподписанный файл.
Собирать это вручную каждый раз — верный способ выпустить релиз без хеша.

Запуск:
    python scripts/release_notes.py                       # в stdout
    python scripts/release_notes.py --out notes.md        # в файл
    python scripts/release_notes.py --version 1.0.1       # другой номер
    python scripts/release_notes.py --exe dist/QuestLog.exe

Текст можно править руками: если файл .github/notes/<версия>.md есть, он
подставляется в раздел «Что нового», иначе берётся список последних
коммитов. Скрипт ничего не публикует — это только текст.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Тот же репозиторий, что и в UPDATE_REPO сервера: ссылка в тексте релиза
# должна ве туда же, куда приложение ходит за обновлениями.
DEFAULT_REPO = "Arthur3web/QuestLog"
EXE_NAME = "QuestLog.exe"


def fail(message):
    print(f"release_notes: {message}", file=sys.stderr)
    sys.exit(1)


def read_version():
    path = ROOT / "VERSION"
    if not path.exists():
        fail("нет файла VERSION")
    return path.read_text(encoding="utf-8").strip()


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def highlights(version, count):
    """Раздел «Что нового»: файл заготовки, иначе — последние коммиты."""
    draft = ROOT / ".github" / "notes" / f"{version}.md"
    if draft.exists():
        return draft.read_text(encoding="utf-8").strip()
    try:
        out = subprocess.run(
            ["git", "log", f"-{count}", "--pretty=format:- %s"],
            cwd=ROOT, capture_output=True, text=True, check=True,
        ).stdout.strip()
    except Exception:
        return ""
    return f"### Что нового\n\n{out}" if out else ""


def build_text(version, exe, repo, count):
    tag = f"v{version}"
    url = f"https://github.com/{repo}/releases/download/{tag}/{EXE_NAME}"
    lines = [
        f"## QuestLog {version}",
        "",
        "Настольная доска задач, которая работает на вашем компьютере: без "
        "аккаунтов, без облака и без интернета. Данные лежат в папке "
        "`~/.questlog`, поэтому переносить программу можно свободно.",
        "",
        "### Скачать (Windows)",
        "",
        f"**[{EXE_NAME}]({url})** — распаковывать не нужно, достаточно "
        "двойного клика. Файл переносимый: старый можно удалить, новый "
        "положить в любую папку, данные от этого не пострадают.",
        "",
        "### Контрольная сумма",
        "",
    ]
    if exe and Path(exe).exists():
        size_mb = os.path.getsize(exe) / 1024 / 1024
        lines += [
            f"Размер: {size_mb:.1f} МБ",
            "",
            "```",
            f"SHA-256: {sha256(exe)}",
            "```",
        ]
    else:
        lines.append("_(хеш добавляется при сборке)_")
    lines += [
        "",
        "### Про неподписанный файл",
        "",
        "Windows при первом запуске может показать «Windows защитила ваш "
        "компьютер». Это реакция на файл без цифровой подписи, а не на "
        "ошибку сборки: «Подробнее» → «Выполнить в любом случае». Убедиться, "
        "что файл не подменён, можно по хешу выше — сверьте его командой "
        "`Get-FileHash`.",
        "",
    ]
    extra = highlights(version, count)
    if extra:
        lines += [extra, ""]
    lines += [
        "---",
        "",
        "Номер версии — из файла `VERSION` в репозитории. Приложение само "
        "проверяет, не вышел ли новый релиз, и показывает в подвале тихую "
        "ссылку; скачивание и замена файла остаются на вас.",
        "",
    ]
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(description="Текст релиза QuestLog")
    ap.add_argument("--version", default="", help="номер версии (по умолчанию из VERSION)")
    ap.add_argument("--exe", default=str(ROOT / "dist" / EXE_NAME),
                    help="собранный файл: из него берутся размер и хеш")
    ap.add_argument("--repo", default=os.environ.get("QUESTLOG_UPDATE_REPO") or DEFAULT_REPO)
    ap.add_argument("--commits", type=int, default=20,
                    help="сколько коммитов показывать, если нет заготовки")
    ap.add_argument("--out", default="", help="записать в файл вместо stdout")
    args = ap.parse_args()

    version = (args.version or read_version()).lstrip("vV")
    text = build_text(version, args.exe, args.repo, args.commits)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8", newline="\n")
        print(f"release_notes: записано в {args.out}")
    else:
        # В CI stdout уходит в файл, поэтому кодировку задаём явно: иначе
        # русский текст в заметках релиза превратится в вопросительные знаки.
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stdout.write(text)


if __name__ == "__main__":
    main()
