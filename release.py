#!/usr/bin/env python3
"""
Выпуск версии по одному запуску: поднять номер, собрать .exe, посчитать
хеш, поставить тег и опубликовать релиз на GitHub.

Зачем один скрипт: выпуск — это семь шагов, и забыть любой из них можно
одинаково хорошо. Особенно тихо забывается хеш (его потом нечем проверить)
и совпадение тега с файлом VERSION (приложение перестаёт предлагать
обновление, и непонятно почему).

Запуск:
    python release.py 1.0.1            # выпустить указанную версию
    python release.py --bump patch     # 1.0.0 -> 1.0.1
    python release.py --bump minor     # 1.0.1 -> 1.1.0
    python release.py --dry-run        # показать план и ничего не сделать

Токен не обязателен: без него скрипт дотолкнёт тег, а релиз соберёт и
опубликует CI (см. .github/workflows/release.yml). С токеном
(GITHUB_TOKEN или GH_TOKEN) релиз создаётся сразу, без ожидания сборки.

Что скрипт НЕ делает: не коммитит чужие изменения и не переписывает
историю. Рабочее дерево должно быть чистым.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VERSION_FILE = ROOT / "VERSION"
NOTES_FILE = ROOT / "release-notes.md"
EXE = ROOT / "dist" / "QuestLog.exe"
API = "https://api.github.com"

sys.path.insert(0, str(ROOT / "scripts"))
from console_out import use_utf8  # noqa: E402  — соседний модуль, путь выше

DEFAULT_REPO = "Arthur3web/QuestLog"
EXE_NAME = "QuestLog.exe"


def fail(message):
    print(f"release: {message}", file=sys.stderr)
    sys.exit(1)


def say(message):
    print(f"release: {message}", flush=True)


def run(cmd, **kwargs):
    """Запустить команду проекта и не продолжать, если она упала."""
    printable = " ".join(str(part) for part in cmd)
    say(f"$ {printable}")
    result = subprocess.run([str(part) for part in cmd], cwd=ROOT, **kwargs)
    if result.returncode != 0:
        fail(f"шаг не удался: {printable}")
    return result


def read_version():
    if not VERSION_FILE.exists():
        fail("нет файла VERSION")
    return VERSION_FILE.read_text(encoding="utf-8").strip()


def bump(version, part):
    numbers = [int(n) for n in re.findall(r"\d+", version)][:3] or [0, 0, 0]
    while len(numbers) < 3:
        numbers.append(0)
    index = {"major": 0, "minor": 1, "patch": 2}[part]
    numbers[index] += 1
    for later in range(index + 1, 3):
        numbers[later] = 0
    return ".".join(str(n) for n in numbers)


def check_clean():
    """Чужой код в коммит не берём: релиз собирается из того, что в git."""
    result = subprocess.run(
        ["git", "status", "--porcelain", "--untracked-files=no"],
        cwd=ROOT, capture_output=True, text=True,
    )
    if result.stdout.strip():
        fail("рабочее дерево изменено — закоммитьте или спрячьте это "
             "до выпуска версии:\n" + result.stdout.strip())
    behind = subprocess.run(
        ["git", "rev-list", "--count", "HEAD..@{u}"],
        cwd=ROOT, capture_output=True, text=True,
    )
    if behind.returncode == 0 and behind.stdout.strip() not in ("", "0"):
        fail("локальная ветка отстаёт от удалённой — сначала git pull")


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_version_inside_exe(version):
    """Номер читается из файла внутри .exe: если файла нет, подвал пуст."""
    listing = subprocess.run(
        [sys.executable, "-m", "PyInstaller.utils.cliutils.archive_viewer", "-l", str(EXE)],
        cwd=ROOT, capture_output=True, text=True,
    )
    if "'VERSION'" not in listing.stdout:
        fail("VERSION не попал в сборочные данные — в собранном файле "
             "версия будет пустой")
    say(f"внутри сборки есть VERSION ({version})")


def github_request(token, method, url, payload=None, data=None, content_type=None):
    body = data
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "QuestLog-release",
    }
    if payload is not None:
        import json
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    elif content_type:
        headers["Content-Type"] = content_type
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    with urllib.request.urlopen(request, timeout=60) as response:
        raw = response.read().decode("utf-8")
    import json
    return json.loads(raw) if raw else {}


def publish(token, repo, tag, notes, exe):
    """Создать релиз и приложить .exe. GitHub API, без gh и без внешних пакетов."""
    try:
        release = github_request(
            token, "POST", f"{API}/repos/{repo}/releases",
            payload={
                "tag_name": tag,
                "name": f"QuestLog {tag}",
                "body": notes,
                "draft": False,
                "prerelease": False,
            },
        )
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:400]
        fail(f"релиз не создан: HTTP {exc.code} {detail}")

    say(f"релиз создан: {release.get('html_url', tag)}")
    if not exe.exists():
        say("файл не найден, релиз останется без приложения")
        return release["html_url"]

    upload_url = release["upload_url"].split("{")[0]
    say(f"загружаю {exe.name} ({exe.stat().st_size / 1024 / 1024:.1f} МБ)")
    with open(exe, "rb") as fh:
        github_request(
            token, "POST", f"{upload_url}?name={EXE_NAME}",
            data=fh.read(), content_type="application/octet-stream",
        )
    say("файл приложён")
    return release["html_url"]


def main():
    ap = argparse.ArgumentParser(description="Выпуск версии QuestLog")
    ap.add_argument("version", nargs="?", help="номер версии, например 1.0.1")
    ap.add_argument("--bump", choices=["major", "minor", "patch"],
                    help="поднять номер в VERSION")
    ap.add_argument("--repo", default=os.environ.get("QUESTLOG_UPDATE_REPO") or DEFAULT_REPO)
    ap.add_argument("--dry-run", action="store_true", help="показать план и выйти")
    ap.add_argument("--skip-tests", action="store_true", help="не гонять тесты и check_js")
    args = ap.parse_args()
    use_utf8()

    current = read_version()
    if args.version:
        version = args.version.lstrip("vV")
    elif args.bump:
        version = bump(current, args.bump)
    else:
        fail("укажите версию (python release.py 1.0.1) или --bump patch")

    tag = f"v{version}"
    digest = sha256(EXE) if EXE.exists() else "—"

    say(f"версия {current} -> {version} ({tag})")
    if args.dry_run:
        say("план: записать VERSION → тесты → сборка → текст релиза → "
            "коммит → тег → push → релиз")
        say(f"хеш текущего dist/{EXE_NAME}: {digest}")
        return

    check_clean()

    # 1. Номер версии — до всего остального: от него зависят и сборка,
    #    и подпись в подвале, и то, что увидит проверка обновлений.
    VERSION_FILE.write_text(version + "\n", encoding="utf-8", newline="\n")
    say(f"VERSION: {current} -> {version}")

    # 2. Проверки. Выпускать непроверенную версию смысла нет: откатывать
    #    публичный релиз неудобно, а тесты идут полминуты.
    if not args.skip_tests:
        run([sys.executable, "-m", "pytest", "-q"])
        run([sys.executable, "check_js.py"])

    # 3. Сборка и проверка того, что получилось.
    run([sys.executable, "build_exe.py"])
    verify_version_inside_exe(version)

    # 4. Текст релиза с хешем получившегося файла.
    run([sys.executable, "scripts/release_notes.py", "--out", str(NOTES_FILE)])
    say(f"SHA-256: {sha256(EXE)}")

    # 5. Коммит с номером версии: тег должен указывать на код, где
    #    версия уже поднята, иначе исходники релиза не соберутся в то же
    #    приложение, которое человек скачает.
    run(["git", "add", "VERSION"])
    run(["git", "commit", "-m", f"build: версия {version}"])
    run(["git", "push", "origin", "HEAD"])
    say("ветка отправлена")

    # 6. Тег и релиз.
    existing = subprocess.run(
        ["git", "rev-parse", "-q", "--verify", f"refs/tags/{tag}"],
        cwd=ROOT, capture_output=True, text=True,
    )
    if existing.returncode != 0:
        run(["git", "tag", "-a", tag, "-m", f"QuestLog {version}"])
    run(["git", "push", "origin", tag])
    say(f"тег {tag} отправлен")

    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if not token:
        say("токена нет — релиз опубликует CI после сборки.")
        say(f"смотреть: https://github.com/{args.repo}/releases")
        return

    notes = NOTES_FILE.read_text(encoding="utf-8")
    url = publish(token, args.repo, tag, notes, EXE)
    say(f"готово: {url}")


if __name__ == "__main__":
    main()
