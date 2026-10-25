#!/usr/bin/env bash
# Humanizer launcher: starts llama.cpp with the humanizer model, then the web
# server, waits for both, prints the URLs. No Node.js anywhere.
#
#   ./run.sh            start everything in the background
#   ./run.sh status     are they up?
#   ./run.sh stop       stop both
#   ./run.sh restart    stop + start
#   ./run.sh fg         run in the foreground (Ctrl+C stops both)
#   ./run.sh logs       follow the logs
#
# Tunables (env): MODEL, NGL, CTX, LLAMA_PORT, APP_PORT
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

MODEL="${MODEL:-$HOME/.cache/huggingface/hub/models--jialinyyzz--humanizer/snapshots/2e57b6528a4070c33f3e09ca24e3325a84272f68/humanizer-12b-IQ2_XS-QAT.gguf}"
NGL="${NGL:-38}"                 # benchmarked: 24 t/s prompt, 8 t/s gen, ~3.6/4 GB VRAM
CTX="${CTX:-8192}"               # the model card requires 8192 for instr + draft + rewrite
LLAMA_PORT="${LLAMA_PORT:-8080}"
APP_PORT="${APP_PORT:-8090}"

LOGS="$ROOT/logs"
LLAMA_PIDFILE="$LOGS/llama.pid"
APP_PIDFILE="$LOGS/app.pid"
mkdir -p "$LOGS" "$ROOT/bin"

say() { printf '%s\n' "$*"; }

find_llama() {
  if command -v llama-server >/dev/null 2>&1; then command -v llama-server
  elif [ -x /home/linuxbrew/.linuxbrew/bin/llama-server ]; then echo /home/linuxbrew/.linuxbrew/bin/llama-server
  else return 1
  fi
}

port_busy() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | grep -qE "[:.]$1[[:space:]]"
  else
    netstat -ltn 2>/dev/null | grep -qE "[:.]$1[[:space:]]"
  fi
}

pid_of() { [ -f "$1" ] && cat "$1" 2>/dev/null || true; }

pid_alive() { local p; p="$(pid_of "$1")"; [ -n "$p" ] && kill -0 "$p" 2>/dev/null; }

wait_http() { # url seconds label  (expects HTTP 200 with "status":"ok" or any 200)
  local url="$1" timeout="$2" label="$3" i=0
  while [ "$i" -lt "$timeout" ]; do
    if curl -sf -m 2 "$url" 2>/dev/null | grep -qE '\{'; then return 0; fi
    sleep 1; i=$((i + 1))
    if [ $((i % 10)) -eq 0 ]; then say "  … still waiting for $label (${i}s)"; fi
  done
  return 1
}

stop_pid() { # pidfile label
  local pid
  pid="$(pid_of "$1")"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
    kill -9 "$pid" 2>/dev/null || true
    say "stopped $2 (pid $pid)"
  fi
  rm -f "$1"
}

cmd_stop() {
  stop_pid "$APP_PIDFILE" "web server"
  stop_pid "$LLAMA_PIDFILE" "llama-server"
}

preflight() {
  local fail=0
  if ! find_llama >/dev/null; then say "ERROR: llama-server not found on PATH (brew install llama.cpp)"; fail=1; fi
  if [ ! -f "$MODEL" ]; then say "ERROR: model not found: $MODEL"; fail=1; fi
  if [ ! -f "$ROOT/server/main.go" ]; then say "ERROR: server/main.go missing"; fail=1; fi
  if ! command -v go >/dev/null 2>&1 && [ ! -x "$ROOT/bin/humanize" ]; then
    say "ERROR: go not installed and no prebuilt bin/humanize"; fail=1
  fi
  [ "$fail" -eq 0 ]
}

start_llama() {
  local bin
  bin="$(find_llama)" || { say "ERROR: llama-server not found"; exit 1; }
  if pid_alive "$LLAMA_PIDFILE"; then say "llama-server already running (pid $(pid_of "$LLAMA_PIDFILE"))"; return 0; fi
  if port_busy "$LLAMA_PORT"; then
    say "ERROR: port $LLAMA_PORT is in use. Run './run.sh stop' or set LLAMA_PORT."
    exit 1
  fi
  say "starting llama-server  (ngl=$NGL ctx=$CTX port=$LLAMA_PORT)"
  nohup "$bin" -m "$MODEL" -c "$CTX" -np 1 -ngl "$NGL" \
    --host 127.0.0.1 --port "$LLAMA_PORT" >"$LOGS/llama.log" 2>&1 &
  echo $! >"$LLAMA_PIDFILE"
  if ! wait_http "http://127.0.0.1:$LLAMA_PORT/health" 180 "llama-server"; then
    say "ERROR: llama-server did not become healthy. Last lines of $LOGS/llama.log:"
    tail -15 "$LOGS/llama.log" || true
    cmd_stop; exit 1
  fi
  say "llama-server ready"
}

build_app() {
  if ! command -v go >/dev/null 2>&1; then
    say "go not installed — reusing existing bin/humanize"; [ -x "$ROOT/bin/humanize" ]; return
  fi
  say "building web server (go build)"
  go build -o "$ROOT/bin/humanize" ./server
}

start_app() {
  if pid_alive "$APP_PIDFILE"; then say "web server already running (pid $(pid_of "$APP_PIDFILE"))"; return 0; fi
  if port_busy "$APP_PORT"; then
    say "ERROR: port $APP_PORT is in use. Run './run.sh stop' or set APP_PORT."
    exit 1
  fi
  nohup "$ROOT/bin/humanize" -addr ":$APP_PORT" \
    -llama "http://127.0.0.1:$LLAMA_PORT" -web "$ROOT/web" \
    >"$LOGS/app.log" 2>&1 &
  echo $! >"$APP_PIDFILE"
  if ! wait_http "http://127.0.0.1:$APP_PORT/api/health" 30 "web server"; then
    say "ERROR: web server did not start. Last lines of $LOGS/app.log:"
    tail -15 "$LOGS/app.log" || true
    cmd_stop; exit 1
  fi
  say "web server ready"
}

banner() {
  say ""
  say "  Humanizer is up:"
  say "    UI     http://127.0.0.1:$APP_PORT"
  say "    llama  http://127.0.0.1:$LLAMA_PORT"
  say "    model  $MODEL"
  say "    logs   $LOGS/{llama,app}.log"
  say ""
  say "  stop with:  ./run.sh stop"
}

cmd_start() {
  preflight
  start_llama
  build_app
  start_app
  banner
}

cmd_status() {
  if pid_alive "$LLAMA_PIDFILE"; then say "llama-server : running (pid $(pid_of "$LLAMA_PIDFILE"))"; else say "llama-server : stopped"; fi
  if pid_alive "$APP_PIDFILE"; then say "web server   : running (pid $(pid_of "$APP_PIDFILE"))"; else say "web server   : stopped"; fi
  curl -sf -m 2 "http://127.0.0.1:$LLAMA_PORT/health" >/dev/null 2>&1 && say "model health : ok" || say "model health : down"
  curl -sf -m 2 "http://127.0.0.1:$APP_PORT/api/health" >/dev/null 2>&1 && say "app health    : ok" || say "app health    : down"
}

cmd_fg() {
  cmd_start
  say "following logs — Ctrl+C stops both"
  trap 'say ""; cmd_stop; exit 0' INT TERM EXIT
  tail -n 0 -f "$LOGS/llama.log" "$LOGS/app.log"
}

case "${1:-start}" in
  start|"") cmd_start ;;
  stop)     cmd_stop ;;
  restart)  cmd_stop; sleep 1; cmd_start ;;
  status)   cmd_status ;;
  fg|foreground) cmd_fg ;;
  logs)     tail -n 50 -f "$LOGS/llama.log" "$LOGS/app.log" ;;
  *) say "usage: ./run.sh [start|stop|restart|status|fg|logs]"; exit 2 ;;
esac
