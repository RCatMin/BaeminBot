#!/bin/bash
# 밥머거 봇 + 대시보드를 껐다 켭니다.
# "밥머거 재시작.app" 아이콘이 이 스크립트를 실행합니다.

set -e

# Finder에서 앱 아이콘으로 실행되면 터미널과 달리 PATH가 최소한으로만 잡혀 있어서
# npm을 못 찾고 조용히 실패합니다 (nohup: npm: No such file or directory).
# Homebrew 설치 경로를 직접 더해서 그 문제를 막습니다.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

PROJECT_DIR="/Users/stupidcatspring/Desktop/Dev/Vive/BaeminBot"
LOG_DIR="$PROJECT_DIR/data/logs"
mkdir -p "$LOG_DIR"

# 이미 떠 있으면 정리 (없어도 에러 안 나게 || true)
pkill -f "bot/index.ts" 2>/dev/null || true
pkill -f "next-server" 2>/dev/null || true
pkill -f "npm run dev" 2>/dev/null || true
pkill -f "npm run bot" 2>/dev/null || true
sleep 1

cd "$PROJECT_DIR"

nohup npm run bot > "$LOG_DIR/bot.log" 2>&1 &
disown

nohup npm run dev > "$LOG_DIR/dashboard.log" 2>&1 &
disown
