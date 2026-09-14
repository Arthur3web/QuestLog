@echo off
setlocal
REM QuestLog desktop launcher (tray + native window) for Windows.
REM NOTE: this file must stay ASCII-only - Cyrillic text in a .bat file breaks cmd on a RU codepage.
cd /d "%~dp0"

REM --- Locate Python: PATH first, then common install locations ---
set "PYTHON="
where python >nul 2>nul && set "PYTHON=python"
if not defined PYTHON where py >nul 2>nul && set "PYTHON=py"

if not defined PYTHON call :try "%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
if not defined PYTHON call :try "%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if not defined PYTHON call :try "%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
if not defined PYTHON call :try "%LOCALAPPDATA%\Programs\Python\Python310\python.exe"
if not defined PYTHON call :try "%LOCALAPPDATA%\Programs\Python\Python39\python.exe"
if not defined PYTHON call :try "C:\Python313\python.exe"
if not defined PYTHON call :try "C:\Python312\python.exe"
if not defined PYTHON call :try "C:\Python311\python.exe"
if not defined PYTHON call :try "%ProgramFiles%\Python313\python.exe"
if not defined PYTHON call :try "%ProgramFiles%\Python312\python.exe"
if not defined PYTHON call :try "%ProgramFiles%\Python311\python.exe"

if not defined PYTHON (
    echo.
    echo [ERROR] Python was not found on this computer.
    echo.
    echo Install Python 3.9+ using one of these methods:
    echo   1^) winget install Python.Python.3.12
    echo   2^) download from https://www.python.org/downloads/windows/
    echo      and check "Add python.exe to PATH" during setup
    echo.
    echo Then run_desktop.bat again.
    pause
    exit /b 1
)

if not exist .venv (
    echo Creating virtual environment .venv ...
    "%PYTHON%" -m venv .venv
    if errorlevel 1 (
        echo [ERROR] Failed to create the virtual environment.
        pause
        exit /b 1
    )
)

set "VENV_PY=.venv\Scripts\python.exe"
if not exist "%VENV_PY%" (
    echo [ERROR] Virtual environment is broken - .venv\Scripts\python.exe missing.
    echo Delete the .venv folder and run_desktop.bat again.
    pause
    exit /b 1
)

echo Installing dependencies...
"%VENV_PY%" -m pip install -q --disable-pip-version-check -r requirements.txt
if errorlevel 1 (
    echo [ERROR] Failed to install dependencies.
    pause
    exit /b 1
)

echo Starting QuestLog desktop app (window + tray icon)...
REM Launched via "start" with pythonw so it detaches from this console:
REM closing the PowerShell/cmd window will NOT stop the app.
set "VENV_PYW=.venv\Scripts\pythonw.exe"
if not exist "%VENV_PYW%" set "VENV_PYW=%VENV_PY%"
start "QuestLog" "%VENV_PYW%" "%~dp0desktop.py" %*
exit /b 0

:try
if exist "%~1" set "PYTHON=%~1"
exit /b 0
