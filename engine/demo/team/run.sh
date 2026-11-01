#!/usr/bin/env bash
# One command that proves the demo end to end without a live client.
#
# Seeds the demo team rig, boots the real daemon in managed mode with the compiled stub
# runner standing in for the native client, starts a run through the same owner endpoint
# `rig team start` calls, and then watches the path that start has to produce by itself:
# the daemon opens the seat's terminal, launches the runner into it, and records the
# launch receipt. Nothing is written to the database or tmux by hand between the start
# request and the launch, so this is the fresh-install path and nothing else.
#
# No provider account, no live token, and no tmux session of the operator's is touched.
#
# Usage, from `engine/` after `npm run build`: bash demo/team/run.sh
set -euo pipefail

ENGINE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ENGINE" || exit 1
export PATH="$ENGINE/node_modules/.bin:$PATH"

SCRATCH="$(mktemp -d)"
export OPENRIG_HOME="$SCRATCH/home"
export OPENRIG_DB="$SCRATCH/demo.sqlite"
export TMUX_TMPDIR="$SCRATCH/tmux"
export MULTI_AGENT_OWNER_TOKEN="demo-owner-$(date +%s)"
export DEMO_PORT="${DEMO_PORT:-7433}"
mkdir -p "$OPENRIG_HOME" "$TMUX_TMPDIR"

cleanup() {
  # The tmux server is this script's own (TMUX_TMPDIR above), so killing it reaches the
  # runner the daemon started; the sweep catches anything the server already lost.
  TMUX_TMPDIR="$TMUX_TMPDIR" tmux kill-server 2>/dev/null || true
  pkill -f "stub-runner.js.*--cwd $SCRATCH" 2>/dev/null || true
  if [ -n "${DAEMON_PID:-}" ]; then kill "$DAEMON_PID" 2>/dev/null || true; wait "$DAEMON_PID" 2>/dev/null || true; fi
  chmod -R u+rwX "$SCRATCH" 2>/dev/null || true
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

echo "==> Seeding the demo team rig"
npx tsx demo/team/scripts/start-team-demo.ts

echo "==> Booting the demo daemon (stub runner, managed mode)"
npx tsx demo/team/scripts/demo-daemon.ts >"$SCRATCH/daemon.log" 2>&1 &
DAEMON_PID=$!
BASE="http://127.0.0.1:$DEMO_PORT"
for _ in $(seq 1 120); do
  if curl --noproxy "*" -fsS "$BASE/healthz" >/dev/null 2>&1; then break; fi
  sleep 0.5
done
curl --noproxy "*" -fsS "$BASE/healthz" >/dev/null || { echo "error: the daemon did not become healthy" >&2; cat "$SCRATCH/daemon.log" >&2; exit 1; }

echo "==> Starting a team run (the request 'rig team start' sends)"
RECEIPT="$(curl --noproxy "*" -fsS -X POST "$BASE/api/team-control/runs" \
  -H "Authorization: Bearer $MULTI_AGENT_OWNER_TOKEN" -H "Content-Type: application/json" \
  -d '{"goal":"Say hello from the demo team"}')"
echo "$RECEIPT"
RUN_ID="$(printf '%s' "$RECEIPT" | sed -n 's/.*"runId":"\([^"]*\)".*/\1/p')"
SEAT="$(printf '%s' "$RECEIPT" | sed -n 's/.*"seat":"\([^"]*\)".*/\1/p')"
[ -n "$RUN_ID" ] && [ -n "$SEAT" ] || { echo "error: no run id or seat in the receipt" >&2; exit 1; }

# The seat had no terminal when the start was made: the demo seed registers rows only.
echo "==> Waiting for the daemon to open the seat's terminal and launch the runner"
LAUNCHED=""
for _ in $(seq 1 120); do
  RECEIPTS="$(curl --noproxy "*" -fsS "$BASE/api/team-control/runs/$RUN_ID/replay?limit=1000" \
    -H "Authorization: Bearer $MULTI_AGENT_OWNER_TOKEN")"
  if printf '%s' "$RECEIPTS" | grep -q 'managed.attempt.receipt'; then LAUNCHED=1; break; fi
  sleep 0.5
done
[ -n "$LAUNCHED" ] || {
  echo "error: no launch receipt was recorded for the seat" >&2
  TMUX_TMPDIR="$TMUX_TMPDIR" tmux capture-pane -p -t "=$SEAT:" 2>/dev/null >&2 || true
  cat "$SCRATCH/daemon.log" >&2
  exit 1
}

echo "==> The seat's terminal is the one the daemon created"
TMUX_TMPDIR="$TMUX_TMPDIR" tmux list-panes -t "=$SEAT:" -F '#{pane_id} #{pane_current_command} #{pane_current_path}'

echo "==> The launch receipt the daemon recorded for this run"
printf '%s' "$RECEIPTS" | npx tsx -e '
const page = JSON.parse(require("fs").readFileSync(0, "utf8"));
for (const event of page.events) console.log("event   seq " + event.seq + "  " + event.type + "  run " + event.runId);
'

echo "==> The runner came up in that pane (the readiness sidecar it wrote)"
npx tsx -e '
const fs = require("fs"), path = require("path");
const sidecars = [];
const walk = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
  const child = path.join(dir, entry.name);
  if (entry.isDirectory()) walk(child);
  else if (child.endsWith(path.join(".openrig", "stub", "state.json"))) sidecars.push(child);
} };
walk(process.argv[1]);
for (const sidecar of sidecars) console.log(sidecar.replace(process.argv[1] + "/", "") + "  " + fs.readFileSync(sidecar, "utf8"));
' "$OPENRIG_HOME/state/workers/assignments"

echo "==> Reading the run back"
curl --noproxy "*" -fsS "$BASE/api/team-control/runs/$RUN_ID/read" -H "Authorization: Bearer $MULTI_AGENT_OWNER_TOKEN" \
  >"$SCRATCH/read.json"
npx tsx -e '
const read = require(process.argv[1]).read;
console.log("run    " + read.run.id + "  " + read.run.state);
console.log("plan   " + read.run.binding.planRef + "  " + read.run.binding.planDigest);
for (const task of read.tasks) console.log("task   " + task.taskId + "  " + task.role + "  " + task.queueState);
for (const attempt of read.attempts) console.log("attempt " + attempt.attemptId + "  " + attempt.state + "  " + attempt.session);
' "$SCRATCH/read.json"

echo "==> Done. The daemon this script started stops when the script exits."
echo "    In a normal session, watch a run at: http://127.0.0.1:$DEMO_PORT/team?run=$RUN_ID"
