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


# ============================================================
# Ветка pywin32: ярлык TaskBoard.lnk вместо .bat
# ============================================================

class _FakeShortCut:
    """Двойник WScript.Shell.CreateShortCut(...): копит присваивания."""

    def __init__(self):
        self.saved = False
        self.Target = None
        self.Arguments = None
        self.WorkingDirectory = None

    def save(self):
        self.saved = True


class _FakeShell:
    last = None  # последний созданный ярлык — для проверок

    def CreateShortCut(self, path):
        _FakeShell.last = _FakeShortCut()
        _FakeShell.last.path = path
        return _FakeShell.last


def _fake_dispatch(name):
    assert name == "WScript.Shell"
    return _FakeShell()


@pytest.fixture()
def fake_win32com(monkeypatch):
    """Подменяет win32com.client.Dispatch, чтобы set_autostart()
    пошёл по ветке pywin32 даже без установленного pywin32."""
    import types

    win32com = types.ModuleType("win32com")
    client = types.ModuleType("win32com.client")
    client.Dispatch = _fake_dispatch
    win32com.client = client
    monkeypatch.setitem(sys.modules, "win32com", win32com)
    monkeypatch.setitem(sys.modules, "win32com.client", client)
    return _FakeShell


@pytest.mark.skipif(not IS_WINDOWS, reason="ярлыки создаются только на Windows")
def test_lnk_branch_uses_pythonw_and_hidden(autostart_dir, fake_win32com):
    """Ярлык: цель — pythonw (без консоли при логине!), аргумент — desktop.py --hidden,
    рабочая папка — корень проекта. Регресс: появление python.exe в Target
    заставило бы cmd-окно мигать при каждом входе в систему."""
    desktop.set_autostart(True)

    lnk = fake_win32com.last
    assert lnk is not None and lnk.saved
    assert os.path.basename(lnk.Target) == "pythonw.exe"
    assert lnk.Arguments.endswith('--hidden')
    assert 'desktop.py' in lnk.Arguments
    assert lnk.WorkingDirectory == str(desktop.BASE_DIR)
    # .bat в ветке ярлыка не создаётся
    assert not (autostart_dir / BAT_NAME).exists()


@pytest.mark.skipif(not IS_WINDOWS, reason="pythonw.exe есть только на Windows")
def test_lnk_falls_back_to_bat_when_dispatch_fails(autostart_dir, monkeypatch):
    """Если pywin32 установлен, но Dispatch падает — должен сработать .bat,
    а не тихо ничего не сделать."""
    import types

    win32com = types.ModuleType("win32com")
    client = types.ModuleType("win32com.client")

    def broken_dispatch(name):
        raise RuntimeError("comкатаклизм")

    client.Dispatch = broken_dispatch
    win32com.client = client
    monkeypatch.setitem(sys.modules, "win32com", win32com)
    monkeypatch.setitem(sys.modules, "win32com.client", client)

    desktop.set_autostart(True)
    assert desktop.autostart_enabled()
    bat = autostart_dir / BAT_NAME
    assert bat.exists() and bat.stat().st_size > 0


# ============================================================
# _launcher_command: выбор pythonw/python
# ============================================================

def test_launcher_prefers_pythonw_when_present(monkeypatch, tmp_path):
    """pythonw.exe «существует» → в команде именно он, а не python.exe:
    автозапуск не должен открывать консольное окно при логине."""
    if not IS_WINDOWS:
        pytest.skip("pythonw.exe есть только на Windows")

    fake_dir = tmp_path / "bin"
    fake_dir.mkdir()
    (fake_dir / "pythonw.exe").write_bytes(b"")
    monkeypatch.setattr(
        sys, "executable", str(fake_dir / "python.exe"), raising=False
    )
    # os.path.exists трогает и другие пути — подменяем точечно:
    real_exists = os.path.exists

    def fake_exists(path):
        if str(path) == str(fake_dir / "pythonw.exe"):
            return True
        return real_exists(path)

    monkeypatch.setattr(os.path, "exists", fake_exists)

    cmd = desktop._launcher_command(True)
    assert "pythonw.exe" in cmd
    assert "python.exe" not in cmd.replace("pythonw.exe", "")
    assert "desktop.py" in cmd and "--hidden" in cmd


def test_launcher_falls_back_to_python_without_pythonw(monkeypatch):
    """pythonw.exe отсутствует → берётся sys.executable, команда всё равно валидна."""
    monkeypatch.setattr(os.path, "exists", lambda p: False)
    cmd = desktop._launcher_command(True)
    assert "pythonw.exe" not in cmd
    assert sys.executable in cmd or os.path.basename(sys.executable) in cmd
    assert "desktop.py" in cmd and "--hidden" in cmd


# ============================================================
# on_toggle_autostart: обработчик пункта меню трея
# ============================================================

def test_toggle_handler_switches_state(autostart_dir, capsys):
    """Обработчик меню переключает автозапуск в противоположное состояние
    и не печатает ничего при успехе. autostart_enabled не мокаем: состояние
    считается по файлам tmp-папки (autostart_dir уже подменён)."""
    was = desktop.autostart_enabled()
    desktop.on_toggle_autostart()
    assert desktop.autostart_enabled() != was

    desktop.on_toggle_autostart()
    assert desktop.autostart_enabled() == was
    assert capsys.readouterr().err == "", "при успехе stderr должен быть пуст"


def test_toggle_handler_swallows_errors(autostart_dir, monkeypatch, capsys):
    """Сбой set_autostart не должен ронять поток трея — ошибка уходит в stderr."""
    def broken(enable):
        raise RuntimeError("диск переполнен")

    monkeypatch.setattr(desktop, "set_autostart", broken)
    desktop.on_toggle_autostart()  # не должно бросать
    assert "диск переполнен" in capsys.readouterr().err
