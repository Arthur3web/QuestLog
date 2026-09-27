"""Тесты автозапуска desktop-режима (desktop.py).

Проверяют полный цикл «включить → файл валиден → выключить → файлов нет»
на временной папке (tmp_path): реальная автозагрузка пользователя не
затрагивается. Главный регресс, который ловим: пустой TaskBoard.bat —
раньше set_autostart() падал на кириллическом пути проекта (ASCII-кодировка
записи) и молча оставлял файл нулевой длины, при этом autostart_enabled()
продолжал отвечать «включено».
"""

import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import desktop  # noqa: E402  — импорт после правки sys.path

IS_WINDOWS = os.name == "nt"
BAT_NAME = "TaskBoard.bat"
LNK_NAME = "TaskBoard.lnk"
LINUX_NAME = "taskboard.desktop"


@pytest.fixture()
def autostart_dir(tmp_path, monkeypatch):
    """Временная папка автозагрузки вместо реальной Startup пользователя."""
    fake = tmp_path / "autostart"
    monkeypatch.setattr(desktop, "autostart_dir", lambda: str(fake))
    return fake


@pytest.fixture()
def restore_user_autostart(autostart_dir):
    """Страховка: если тест упадёт посреди цикла — вернуть как было.

    Тесты переопределяют desktop.autostart_dir(), поэтому с реальной
    автозагрузкой не пересекаются; фикстура нужна на случай ошибки внутри
    теста, чтобы состояние приложения (меню трея) осталось согласованным.
    """
    was = desktop.autostart_enabled()
    yield
    if desktop.autostart_enabled() != was:
        desktop.set_autostart(was)


def test_disabled_by_default_on_empty_dir(autostart_dir):
    assert not desktop.autostart_enabled()


def test_enable_creates_nonempty_file(autostart_dir, restore_user_autostart):
    desktop.set_autostart(True)

    assert desktop.autostart_enabled()

    if IS_WINDOWS:
        # Без pywin32 (как в CI и на машинах без pywin32) пишется .bat
        bat = autostart_dir / BAT_NAME
        if bat.exists():
            content = bat.read_text(encoding="utf-8")
            # Файл не пуст и содержит команду запуска desktop.py
            assert bat.stat().st_size > 0, "пустой .bat — регресс крэша кодировки"
            assert "desktop.py" in content
            assert "--hidden" in content
        # С pywin32 вместо .bat создаётся ярлык; главное, что файл есть
        assert (autostart_dir / LNK_NAME).exists() or bat.exists()
    else:
        entry = autostart_dir / LINUX_NAME
        assert entry.exists()
        content = entry.read_text(encoding="utf-8")
        assert "[Desktop Entry]" in content
        assert "desktop.py" in content
        assert content.strip(), "пустой .desktop — регресс"


def test_bat_writes_cyrillic_paths(autostart_dir, restore_user_autostart, monkeypatch):
    """Бат-файл должен корректно записываться при кириллице в путях.

    Регресс: ASCII-кодировка записи падала на не-ASCII пути и оставляла
    пустой файл. Симулируем кириллический BASE_DIR через monkeypatch.
    """
    if not IS_WINDOWS:
        pytest.skip("bat-файлы создаются только на Windows")

    monkeypatch.setattr(desktop, "BASE_DIR", str(ROOT / "тест папка"))
    desktop.set_autostart(True)

    bat = autostart_dir / BAT_NAME
    if bat.exists():  # при установленном pywin32 будет .lnk — тогда не проверяем
        assert bat.stat().st_size > 0, "кириллический путь сломал запись .bat"
        content = bat.read_text(encoding="utf-8")
        assert "тест папка" in content


def test_disable_removes_all_autostart_files(autostart_dir, restore_user_autostart):
    desktop.set_autostart(True)
    assert desktop.autostart_enabled()

    # Мусор от прежних версий: бэкап и ярлык — тоже должны удалиться
    (autostart_dir / (BAT_NAME + ".bak")).write_text("old", encoding="utf-8")

    desktop.set_autostart(False)

    assert not desktop.autostart_enabled()
    for name in (BAT_NAME, BAT_NAME + ".bak", LNK_NAME, LINUX_NAME):
        assert not (autostart_dir / name).exists()


def test_disable_is_safe_when_nothing_to_remove(autostart_dir):
    desktop.set_autostart(False)  # не должно падать на пустой папке
    assert not desktop.autostart_enabled()
