@echo off
REM ============================================================
REM  StockCouncil 一键启动（Windows CMD）
REM ============================================================
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [x] 未检测到 Node.js，请先安装 Node ^>= 20： https://nodejs.org/
  pause
  exit /b 1
)

if not exist ".env" (
  if exist ".env.example" (
    echo [i] 未发现 .env，已从 .env.example 复制一份，请按需填写 API Key。
    copy /y ".env.example" ".env" >nul
  )
)

echo [i] 正在启动 StockCouncil ...
node server\index.mjs
pause