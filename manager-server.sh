#!/usr/bin/env bash
# Manage the job-hunter dashboard server: setup, start, stop, status.
#
# Setup is not a separate step you have to remember — `start` runs whatever is
# missing before launching. The checks are the state (no marker file), so
# deleting node_modules or dist is enough to make the next start repair it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$ROOT/data/server.pid"
LOG_FILE="$ROOT/data/server.log"
STOP_WAIT=10   # seconds to wait for a graceful shutdown before SIGKILL
START_WAIT=15  # seconds to wait for the health endpoint after launching

if [ -t 1 ]; then
  BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; OFF=$'\033[0m'
else
  BOLD=''; RED=''; GREEN=''; YELLOW=''; DIM=''; OFF=''
fi

say()  { printf '%s\n' "$*"; }
ok()   { printf '%s✓%s %s\n' "$GREEN" "$OFF" "$*"; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$OFF" "$*"; }
die()  { printf '%s✗%s %s\n' "$RED" "$OFF" "$*" >&2; exit 1; }
step() { printf '%s→%s %s\n' "$DIM" "$OFF" "$*"; }

# Mirrors the server's own precedence (server/paths.mjs loads .env itself, so a
# PORT set there wins over the built-in default but not over the environment).
resolve_port() {
  if [ -n "${PORT:-}" ]; then printf '%s' "$PORT"; return; fi
  if [ -f "$ROOT/.env" ]; then
    local from_env
    from_env="$(sed -n 's/^[[:space:]]*PORT[[:space:]]*=[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$ROOT/.env" | tail -1)"
    if [ -n "$from_env" ]; then printf '%s' "$from_env"; return; fi
  fi
  printf '4680'
}

PORT_NUM="$(resolve_port)"
URL="http://localhost:$PORT_NUM"

# A pidfile alone proves nothing — the number can be stale or reused by an
# unrelated process, so confirm the command line really is our server.
server_pid() {
  [ -f "$PID_FILE" ] || return 1
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null || return 1
  if [ -r "/proc/$pid/cmdline" ] && ! tr '\0' ' ' < "/proc/$pid/cmdline" | grep -q 'server/index.mjs'; then
    return 1
  fi
  printf '%s' "$pid"
}

healthy() { curl -sf -m 3 -o /dev/null "$URL/api/health" 2>/dev/null; }

# --- setup ------------------------------------------------------------------

run_setup() {
  local did=0
  mkdir -p "$ROOT/data"
  if [ ! -d "$ROOT/node_modules" ]; then
    step "Installing server dependencies…"; (cd "$ROOT" && npm install); did=1
  fi
  if [ ! -d "$ROOT/web/node_modules" ]; then
    step "Installing web dependencies…"; (cd "$ROOT" && npm install --prefix web); did=1
  fi
  if [ ! -d "$ROOT/web/dist" ]; then
    step "Building the frontend…"; (cd "$ROOT" && npm run build); did=1
  fi
  [ "$did" -eq 1 ] && ok "Setup complete." || true
  return 0
}

cmd_setup() { run_setup; ok "Everything is in place."; }

cmd_build() {
  [ -d "$ROOT/web/node_modules" ] || { step "Installing web dependencies…"; (cd "$ROOT" && npm install --prefix web); }
  step "Rebuilding the frontend…"
  (cd "$ROOT" && npm run build)
  ok "Frontend rebuilt."
}

# --- start / stop / status --------------------------------------------------

cmd_start() {
  local pid
  if pid="$(server_pid)"; then
    warn "Already running (pid $pid) at $URL"
    return 0
  fi
  [ -f "$PID_FILE" ] && rm -f "$PID_FILE"   # stale pidfile from a crash

  run_setup

  step "Starting server on port $PORT_NUM…"
  # Launch node directly rather than via `npm start`: the pid we record is then
  # the server itself, so stop signals it instead of npm (which would leave the
  # real process orphaned), and the cmdline check below can identify it.
  # `exec` matters — it replaces the subshell with node, so $! is node's own pid
  # rather than a wrapper's that exits immediately.
  ( cd "$ROOT" && exec nohup node server/index.mjs >>"$LOG_FILE" 2>&1 ) &
  echo $! >"$PID_FILE"

  local waited=0
  while [ "$waited" -lt "$START_WAIT" ]; do
    if healthy; then
      ok "${BOLD}job-hunter running at $URL${OFF}"
      say "  ${DIM}logs: $LOG_FILE${OFF}"
      return 0
    fi
    if ! server_pid >/dev/null; then
      printf '%s✗%s Server exited during startup. Last lines of %s:\n' "$RED" "$OFF" "$LOG_FILE" >&2
      tail -20 "$LOG_FILE" >&2 2>/dev/null || true
      rm -f "$PID_FILE"
      exit 1
    fi
    sleep 1
    waited=$((waited + 1))
  done

  warn "Started (pid $(cat "$PID_FILE")) but $URL/api/health did not answer in ${START_WAIT}s."
  say "  ${DIM}check: $LOG_FILE${OFF}"
  return 1
}

cmd_stop() {
  local pid
  if ! pid="$(server_pid)"; then
    [ -f "$PID_FILE" ] && { rm -f "$PID_FILE"; warn "Removed a stale pidfile; nothing was running."; } \
                       || say "Not running."
    return 0
  fi

  step "Stopping pid $pid…"
  kill -TERM "$pid" 2>/dev/null || true
  local waited=0
  while [ "$waited" -lt "$STOP_WAIT" ]; do
    kill -0 "$pid" 2>/dev/null || { rm -f "$PID_FILE"; ok "Stopped."; return 0; }
    sleep 1
    waited=$((waited + 1))
  done

  warn "Still alive after ${STOP_WAIT}s — sending SIGKILL."
  kill -KILL "$pid" 2>/dev/null || true
  sleep 1
  rm -f "$PID_FILE"
  ok "Stopped (forced)."
}

cmd_restart() { cmd_stop; cmd_start; }

cmd_status() {
  local pid rc
  printf '%sjob-hunter%s\n' "$BOLD" "$OFF"
  if pid="$(server_pid)"; then
    local up
    up="$(ps -o etime= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
    printf '  state    %srunning%s (pid %s%s)\n' "$GREEN" "$OFF" "$pid" "${up:+, up $up}"
    printf '  url      %s\n' "$URL"
    if healthy; then printf '  health   %sok%s\n' "$GREEN" "$OFF"
    else            printf '  health   %snot responding%s\n' "$RED" "$OFF"; fi
    rc=0
  else
    printf '  state    %sstopped%s\n' "$RED" "$OFF"
    printf '  port     %s\n' "$PORT_NUM"
    # Something can hold the port without this script having started it (a manual
    # `npm start`, an older shell). Say so rather than claiming the port is free.
    if healthy; then
      printf '  %s! port %s is already answering — a server is running that this script did not start%s\n' \
        "$YELLOW" "$PORT_NUM" "$OFF"
    fi
    rc=3
  fi

  local deps="missing" dist="missing"
  [ -d "$ROOT/node_modules" ] && [ -d "$ROOT/web/node_modules" ] && deps="installed"
  [ -d "$ROOT/web/dist" ] && dist="built"
  printf '  deps     %s\n' "$deps"
  printf '  frontend %s\n' "$dist"
  printf '  logs     %s\n' "$LOG_FILE"
  return "$rc"
}

cmd_help() {
  cat <<EOF
${BOLD}manager-server.sh${OFF} — manage the job-hunter dashboard

${BOLD}USAGE${OFF}
  ./manager-server.sh <command>

${BOLD}COMMANDS${OFF}
  start      Start the server in the background (runs setup first if needed)
  stop       Stop it, gracefully, then forcefully after ${STOP_WAIT}s
  restart    Stop then start
  status     Show whether it is running, its health, and what is installed
  setup      Install dependencies and build the frontend if any are missing
  build      Force a frontend rebuild (start only builds when dist is absent)
  help       This message

${BOLD}NOTES${OFF}
  Port comes from \$PORT, else PORT in .env, else 4680.
  pid and log live in data/ (gitignored): $LOG_FILE
  status exits 0 when running, 3 when stopped, so it works in other scripts.

  ${DIM}After editing anything in web/src, run 'build' — start will not notice.${OFF}
EOF
}

case "${1:-help}" in
  start)            cmd_start ;;
  stop)             cmd_stop ;;
  restart)          cmd_restart ;;
  status)           cmd_status ;;
  setup)            cmd_setup ;;
  build)            cmd_build ;;
  help|-h|--help)   cmd_help ;;
  *)                printf '%s✗%s Unknown command: %s\n\n' "$RED" "$OFF" "$1" >&2; cmd_help >&2; exit 2 ;;
esac
