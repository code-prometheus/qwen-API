@echo off
title Qwen Web2API Server
cd /d "%~dp0"

if not exist "node_modules" (
  echo ============================================
  echo   首次运行 — 正在安装依赖...
  echo ============================================
  call npm install
  echo.
)

if not exist "dist" (
  echo 正在编译 TypeScript...
  call npm run build
  echo.
)

if not exist ".env" (
  echo ============================================
  echo   创建 .env 配置文件...
  echo ============================================
  copy .env.example .env > nul 2>&1
  echo 已创建 .env 文件，请用记事本编辑：
  echo   %~dp0.env
  echo.
  echo 至少需要填入 QWEN_EMAIL 和 QWEN_PASSWORD
  echo 编辑完成后重新运行此脚本即可启动服务。
  echo ============================================
  start notepad .env
  pause
  exit /b
)

echo ============================================
echo   Qwen Web2API Server
echo   端口: 5419  仪表盘: http://localhost:5419/dashboard
echo ============================================
echo.

node dist\index.js

pause
