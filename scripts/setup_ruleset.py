#!/usr/bin/env python3
"""
Правила для основной ветки: запрет force push и обязательные проверки.

Зачем это настраивать: история уже переписывалась один раз. Пока репозиторий
живёт на одной машине, обойтись можно, но первая же случайная команда с
`-f` уносит неделю работы, а восстановить её придётся по reflog вручную.

Что ставим:
  • запрет force push и удаления ветки master;
  • обязательная проверка `tests` из workflow «Проверки» перед слиянием;
  • требовать, чтобы ветка была актуальна (strict) — иначе зелёная
    проверка на старой версии кода проходит и мержится уже сломанный код.

Запуск (нужен токен с правом администратора на репозиторий):
    GITHUB_TOKEN=... python scripts/setup_ruleset.py
    GITHUB_TOKEN=... python scripts/setup_ruleset.py --require-pr
    GITHUB_TOKEN=... python scripts/setup_ruleset.py --dry-run

Токен — обычный PAT с областью `repo`, у него есть права администратора
на ваши репозитории. То же самое можно сделать руками: Settings →
Rules → Rulesets → New ruleset → Branch, target `refs/heads/master`.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from console_out import use_utf8  # noqa: E402  — соседний модуль

API = "https://api.github.com"
DEFAULT_REPO = "Arthur3web/QuestLog"
RULESET_NAME = "master"
CHECK = "tests"   # имя job в .github/workflows/tests.yml


def build_ruleset(require_pr):
    rules = [
        {"type": "deletion"},       # удалить ветку master нельзя
        {"type": "non_fast_forward"},  # и переписать её историю тоже
        {
            "type": "required_status_checks",
            "parameters": {
                # strict: ветка должна быть обновлена — зелёная проверка
                # на устаревшей версии не должна пропускать слияние.
                "strict_required_status_checks_policy": True,
                "required_status_checks": [{"context": CHECK}],
            },
        },
    ]
    if require_pr:
        rules.append({
            "type": "pull_request",
            "parameters": {
                "required_approving_review_count": 0,
                "dismiss_stale_reviews_on_push": False,
                "require_last_push_approval": False,
                "required_review_thread_resolution": False,
                "require_code_owner_review": False,
                "allow_knative_bypass": "bypass",
                # Историю не переписываем: force push запрещён, поэтому
                # merge commit здесь безопаснее, чем squash с потерей
                # деталей и rebase с длинной историей.
                "allowed_merge_methods": ["merge", "squash"],
            },
        })
    return {
        "name": RULESET_NAME,
        "target": "branch",
        "enforcement": "active",
        "bypass_actors": [],
        "conditions": {"ref_name": {"include": ["~DEFAULT_BRANCH"], "exclude": []}},
        "rules": rules,
    }


def request(token, method, url, payload=None):
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "QuestLog-setup",
    }
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=60) as response:
        body = response.read().decode("utf-8")
    return json.loads(body) if body else {}


def main():
    ap = argparse.ArgumentParser(description="Правила ветки master на GitHub")
    ap.add_argument("--repo", default=os.environ.get("QUESTLOG_UPDATE_REPO") or DEFAULT_REPO)
    ap.add_argument("--require-pr", action="store_true",
                    help="запретить прямые пуши: только через pull request")
    ap.add_argument("--dry-run", action="store_true",
                    help="показать правила и выйти без обращения к GitHub")
    args = ap.parse_args()
    use_utf8()

    ruleset = build_ruleset(args.require_pr)
    if args.dry_run:
        print(json.dumps(ruleset, ensure_ascii=False, indent=2))
        return

    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if not token:
        print("setup_ruleset: нет токена. Задайте GITHUB_TOKEN (PAT с правом "
              "администратора на репозиторий) и повторите.", file=sys.stderr)
        sys.exit(1)

    existing = request(token, "GET", f"{API}/repos/{args.repo}/rulesets")
    for item in existing if isinstance(existing, list) else []:
        if item.get("name") == RULESET_NAME:
            print(f"setup_ruleset: правило «{RULESET_NAME}» уже есть "
                  f"(id {item.get('id')}) — обновляю.", file=sys.stderr)
            request(token, "PUT",
                    f"{API}/repos/{args.repo}/rulesets/{item['id']}", ruleset)
            print("setup_ruleset: обновлено")
            return

    try:
        created = request(token, "POST", f"{API}/repos/{args.repo}/rulesets", ruleset)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        print(f"setup_ruleset: GitHub отклонил правило (HTTP {exc.code})", file=sys.stderr)
        print(detail[:600], file=sys.stderr)
        if CHECK in detail:
            print("\nЧаще всего это означает, что проверка с таким именем ещё "
                  f"ни разу не отработала: влейте ветку и дождитесь "
                  f"workflow «Проверки», потом повторите.", file=sys.stderr)
        sys.exit(1)

    print(f"setup_ruleset: правило создано, id {created.get('id')}")
    print(f"Теперь force push в {args.repo}:master невозможен, а слияние "
          f"потребует зелёной проверки «{CHECK}».")


if __name__ == "__main__":
    main()
