@echo off
chcp 65001 >nul
title RomM Translator Launcher
cd /d "%~dp0"

REM Pure ASCII launcher: all logic and messages live in start.js
REM (UTF-8 batch files break under cmd's GBK pre-buffering, so no Chinese here)

set "PORTABLE_NODE=%~dp0node"
if exist "%PORTABLE_NODE%\node.exe" (
    set "PATH=%PORTABLE_NODE%;%PATH%"
)

node -v >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found.
    echo Please extract a portable Node.js win-x64 into the "node" folder,
    echo or install system Node.js, then run this script again.
    pause
    exit /b 1
)

node start.js

pause
