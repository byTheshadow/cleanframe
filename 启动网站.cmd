@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo 未找到 Node.js。请安装 Node.js 20 或更高版本后重试。
  echo https://nodejs.org/
  echo.
  pause
  exit /b 1
)
node server.mjs --open
if errorlevel 1 pause
