#!/usr/bin/env bash
# Manage the job-hunter dashboard server (node server/index.mjs) in the background.
# Usage: ./server-manage.sh {start|stop|restart|status|logs [lines]}
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$ROOT/data"
PID_FILE="$DATA_DIR/server.pid"
LOG_FILE="$DATA_DIR/server.log"

# PORT: environment wins, then .env, then the server's default.
if [[ -z "${PORT:-}" && -f "$ROOT/.env" ]]; then
  PORT="$(sed -n 's/^[[:space:]]*PORT[[:space:]]*=[[:space:]]*//p' "$ROOT/.env" | tail -n1 | tr -d '"'"'"' \r')"
fi
PORT="${PORT:-4680}"

running_pid() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid="$(<"$PID_FILE")"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    echo "$pid"
  else
    rm -f "$PID_FILE"
    return 1
  fi
}

start() {
  local pid
  if pid="$(running_pid)"; then
    echo "Already running (pid $pid) on http://localhost:$PORT"
    return 0
  fi
  if [[ ! -f "$ROOT/web/dist/index.html" ]]; then
    echo "Warning: web/dist not found — run 'npm run build' for the frontend."
  fi
  mkdir -p "$DATA_DIR"
  cd "$ROOT"
  nohup node server/index.mjs >>"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  sleep 1
  if pid="$(running_pid)"; then
    echo "Started (pid $pid) on http://localhost:$PORT — logs: $LOG_FILE"
  else
    echo "Failed to start. Last log lines:"
    tail -n 20 "$LOG_FILE"
    return 1
  fi
}

stop() {
  local pid
  if ! pid="$(running_pid)"; then
    echo "Not running."
    return 0
  fi
  kill "$pid"
  for _ in {1..20}; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "Did not exit after 10s; sending SIGKILL."
    kill -9 "$pid"
  fi
  rm -f "$PID_FILE"
  echo "Stopped (pid $pid)."
}

status() {
  local pid
  if pid="$(running_pid)"; then
    echo "Running (pid $pid) on http://localhost:$PORT"
    if command -v curl >/dev/null; then
      if curl -fsS -o /dev/null --max-time 3 "http://localhost:$PORT/"; then
        echo "HTTP: responding"
      else
        echo "HTTP: not responding"
      fi
    fi
  else
    echo "Not running."
    return 3
  fi
}

case "${1:-}" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; start ;;
  status)  status ;;
  logs)    touch "$LOG_FILE"; tail -n "${2:-50}" -f "$LOG_FILE" ;;
  *) echo "Usage: $0 {start|stop|restart|status|logs [lines]}"; exit 2 ;;
esac
