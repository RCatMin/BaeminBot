#!/bin/bash
# 밥머거 봇 + 대시보드를 껐다 켭니다.
# "밥머거 재시작.app" 아이콘이 이 스크립트를 실행합니다.

set -e

# Finder에서 앱 아이콘으로 실행되면 터미널과 달리 PATH가 최소한으로만 잡혀 있어서
# npm을 못 찾고 조용히 실패합니다 (nohup: npm: No such file or directory).
# Homebrew 설치 경로를 직접 더해서 그 문제를 막습니다.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# ── 프로젝트 위치 찾기 ──────────────────────────────────────────────────────
# 경로를 적어두면 저장소를 클론한 사람은 경로가 달라서 그대로 쓸 수 없습니다.
# 그래서 이 스크립트가 놓인 자리에서 거꾸로 알아냅니다.
#
# 앱 아이콘이 이 스크립트에 심볼릭 링크를 걸어둔 경우, 링크가 놓인 자리(예: 데스크탑)를
# 프로젝트로 착각하면 안 되므로 링크를 끝까지 따라가 실제 파일 위치를 찾습니다.
# (readlink -f 가 없는 환경도 있어서, 없으면 한 단계씩 직접 따라갑니다)
SCRIPT_PATH="${BASH_SOURCE[0]}"
if ! SCRIPT_PATH="$(readlink -f "$SCRIPT_PATH" 2>/dev/null)"; then
  SCRIPT_PATH="${BASH_SOURCE[0]}"
  while [ -L "$SCRIPT_PATH" ]; do
    link_target="$(readlink "$SCRIPT_PATH")"
    case "$link_target" in
      /*) SCRIPT_PATH="$link_target" ;;
      *) SCRIPT_PATH="$(dirname "$SCRIPT_PATH")/$link_target" ;;
    esac
  done
fi

SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_PATH")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

LOG_DIR="$PROJECT_DIR/data/logs"
mkdir -p "$LOG_DIR"

DASHBOARD_PORT="${DASHBOARD_PORT:-3000}"

# ── 이미 떠 있는 프로세스 정리 ──────────────────────────────────────────────
# 명령줄만 보면 "npm run dev" · "next-server" 처럼 다른 프로젝트와 구분이 안 됩니다.
# pkill -f "npm run dev" 로 넓게 잡으면 남이 돌리던 개발 서버까지 죽으므로,
# 프로세스의 작업 폴더(cwd)가 이 프로젝트인지까지 확인하고 죽입니다.
#
# 이 방식은 PID 기록에 의존하지 않아서, 예전 스크립트로 띄워둔 프로세스나
# 재부팅 뒤 남아 있던 프로세스도 빠짐없이 정리됩니다.

# 우리가 띄우는 프로세스들의 명령줄 특징입니다. 같은 폴더에서 돌더라도 여기 안 걸리는 건
# 편집기 언어 서버처럼 남의 도구일 수 있으므로 건드리지 않습니다.
# (특히 이 폴더에서 도는 다른 node 프로세스를 잡지 않도록 좁게 씁니다)
OUR_PROCESSES='bot/index\.ts|npm run (bot|dev)|next-server|node_modules/\.bin/next|\.next/dev/'

process_cwd() {
  lsof -a -d cwd -p "$1" -Fn 2>/dev/null | sed -n 's/^n//p' | head -1
}

for pid in $(pgrep -u "$(id -u)" -f "$OUR_PROCESSES" 2>/dev/null || true); do
  # 이 스크립트 자신(과 부모)은 건너뜁니다.
  if [ "$pid" = "$$" ] || [ "$pid" = "$PPID" ]; then
    continue
  fi
  if [ "$(process_cwd "$pid")" = "$PROJECT_DIR" ]; then
    kill "$pid" 2>/dev/null || true
  fi
done

# 대시보드 포트가 풀릴 때까지 잠깐 기다립니다.
# 아직 잡혀 있는 상태로 next dev 를 띄우면 "이미 실행 중"이라며 조용히 끝나버려서,
# 대시보드가 안 떴다는 걸 로그를 열어보기 전까지 눈치채기 어렵습니다.
for _ in $(seq 1 20); do
  if [ -z "$(lsof -ti "tcp:$DASHBOARD_PORT" 2>/dev/null || true)" ]; then
    break
  fi
  sleep 0.25
done

# ── 다시 띄우기 ─────────────────────────────────────────────────────────────
cd "$PROJECT_DIR"

nohup npm run bot > "$LOG_DIR/bot.log" 2>&1 &
disown

nohup npm run dev > "$LOG_DIR/dashboard.log" 2>&1 &
disown
