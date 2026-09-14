#!/usr/bin/env bash
# Запуск QuestLog на Linux/macOS.
set -e
cd "$(dirname "$0")"

if [ ! -d ".venv" ]; then
    echo "Создаю виртуальное окружение (.venv)…"
    python3 -m venv .venv
fi

source .venv/bin/activate
pip install -q -r requirements.txt

echo "Открываю http://127.0.0.1:8420 в браузере через пару секунд…"
( sleep 1.5 && python3 -m webbrowser -t "http://127.0.0.1:8420" ) &

python3 server.py
