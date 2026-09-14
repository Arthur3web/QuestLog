#!/usr/bin/env bash
# Запуск QuestLog в режиме настольного приложения (окно + трей) на Linux.
set -e
cd "$(dirname "$0")"

if [ ! -d ".venv" ]; then
    echo "Создаю виртуальное окружение (.venv)…"
    python3 -m venv .venv
fi

source .venv/bin/activate
pip install -q -r requirements.txt

exec python3 desktop.py "$@"
