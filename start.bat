@echo off
chcp 65001 >nul
title AI 多智能体编排系统 - 一键启动服务

echo ========================================================
echo        🤖 AI 多智能体编排系统 | 双脑协同引擎
echo        策略脑: LongCat-2.0
echo        执行脑: Antigravity Agent
echo        技能库: 🔮 技能炼化 (Skill Alchemy) 动态加载
echo ========================================================
echo.

:: 1. 检查 Node.js 环境
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo ❌ 错误：未检测到 Node.js 环境，请先安装 Node.js (https://nodejs.org)!
    pause
    exit /b 1
)

:: 2. 检查 3000 端口是否已被占用
netstat -ano | findstr ":3000 " >nul 2>nul
if %errorlevel% equ 0 (
    echo ⚠️ 提示：3000 端口已被占用，正在清理旧进程...
    for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000 "') do (
        taskkill /F /PID %%a >nul 2>nul
    )
    timeout /t 1 >nul
)

:: 3. 启动后端服务器
echo 🚀 正在启动后台服务引擎 (backend/server.js)...
start "AI-Orchestrator-Backend" /min node backend/server.js

:: 4. 等待服务器就绪
echo ⏳ 等待服务器就绪...
timeout /t 2 >nul

:: 5. 自动打开浏览器
echo 🌐 正在打开默认浏览器访问 http://localhost:3000 ...
start http://localhost:3000

echo.
echo ========================================================
echo ✅ 系统已成功一键启动！
echo 📌 控制台与 WebSocket 服务运行在: http://localhost:3000
echo 💡 如需停止服务，请直接关闭弹出的 后台服务 窗口。
echo ========================================================
echo.
pause
