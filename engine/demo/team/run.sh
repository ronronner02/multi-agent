#!/usr/bin/env bash
# One command that proves the demo end to end without a live client.
#
# Seeds the demo team rig, boots the real daemon in managed mode with the compiled stub
# runner standing in for the native client, starts a run through the same owner endpoint
# `rig team start` calls, and reads the created task back from the run's own projection.
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
  if [ -n "${DAEMON_PID:-}" ]; then kill "$DAEMON_PID" 2>/dev/null || true; wait "$DAEMON_PID" 2>/dev/null || true; fi
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

echo "==> Starting a team run"
RECEIPT="$(curl --noproxy "*" -fsS -X POST "$BASE/api/team-control/runs" \
  -H "Authorization: Bearer $MULTI_AGENT_OWNER_TOKEN" -H "Content-Type: application/json" \
  -d '{"goal":"Say hello from the demo team"}')"
echo "$RECEIPT"
RUN_ID="$(printf '%s' "$RECEIPT" | sed -n 's/.*"runId":"\([^"]*\)".*/\1/p')"
[ -n "$RUN_ID" ] || { echo "error: no run id in the receipt" >&2; exit 1; }

echo "==> Reading the run back"
curl --noproxy "*" -fsS "$BASE/api/team-control/runs/$RUN_ID/read" -H "Authorization: Bearer $MULTI_AGENT_OWNER_TOKEN" \
  >"$SCRATCH/read.json"
npx tsx -e '
const read = require(process.argv[1]).read;
console.log("run    " + read.run.id + "  " + read.run.state);
console.log("plan   " + read.run.binding.planRef + "  " + read.run.binding.planDigest);
for (const task of read.tasks) console.log("task   " + task.taskId + "  " + task.role + "  " + task.queueState);
' "$SCRATCH/read.json"

echo "==> Done. The daemon this script started stops when the script exits."
echo "    In a normal session, watch a run with: rig tui --team --run $RUN_ID"
