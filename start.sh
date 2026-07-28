#!/usr/bin/env bash
# AI 多智能体编排系统 一键启动脚本 (Linux/macOS)

echo "========================================================"
echo "       🤖 AI 多智能体编排系统 | 双脑协同引擎"
echo "========================================================"

if ! command -v node &> /dev/null; then
    echo "❌ 错误：未检测到 Node.js 环境，请先安装 Node.js!"
    exit 1
fi

echo "🚀 正在启动后台服务..."
node backend/server.js &
SERVER_PID=$!

sleep 2

echo "🌐 正在打开浏览器访问 http://localhost:3000 ..."
if command -v xdg-open &> /dev/null; then
    xdg-open "http://localhost:3000"
elif command -v open &> /dev/null; then
    open "http://localhost:3000"
else
    echo "请手动在浏览器打开: http://localhost:3000"
fi

wait $SERVER_PID
