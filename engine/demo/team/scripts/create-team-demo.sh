#!/usr/bin/env bash
# One command that proves U3 end to end, without a live client.
#
# Creates a team for a scratch repository with the real `rig team create` verb against a
# managed daemon, then starts a run on that team and waits for the daemon to open the seat's
# terminal and launch the stub runner into it. A second team with only an implementer seat is
# created through the same endpoint, to show a run landing on an implementer seat.
#
# Everything lives under one mktemp directory — the daemon's home and database, the tmux server
# the seat's pane lives on, and the scratch repositories — and is removed on success or failure.
#
# The variables are exported before node starts: the daemon reads OPENRIG_HOME once, at module
# load. OPENRIG_URL is what points the compiled CLI at this demo daemon instead of a state file.
#
# Usage, from `engine/` after `npm run build`: bash demo/team/scripts/create-team-demo.sh
set -euo pipefail

ENGINE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ENGINE" || exit 1
export PATH="$ENGINE/node_modules/.bin:$PATH"

SCRATCH="$(mktemp -d)"
export OPENRIG_HOME="$SCRATCH/home"
export OPENRIG_DB="$SCRATCH/demo.sqlite"
export TMUX_TMPDIR="$SCRATCH/tmux"
export MULTI_AGENT_OWNER_TOKEN="demo-owner-$(date +%s)"
export DEMO_PORT="${DEMO_PORT:-7434}"
export OPENRIG_URL="http://127.0.0.1:$DEMO_PORT"
mkdir -p "$OPENRIG_HOME" "$TMUX_TMPDIR"
BASE="$OPENRIG_URL"
RIG=(node "$ENGINE/packages/cli/dist/bin-wrapper.js")

cleanup() {
  TMUX_TMPDIR="$TMUX_TMPDIR" tmux kill-server 2>/dev/null || true
  pkill -f "stub-runner.js.*--cwd $SCRATCH" 2>/dev/null || true
  if [ -n "${DAEMON_PID:-}" ]; then kill "$DAEMON_PID" 2>/dev/null || true; wait "$DAEMON_PID" 2>/dev/null || true; fi
  chmod -R u+rwX "$SCRATCH" 2>/dev/null || true
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

repository() {
  local root="$1"
  mkdir -p "$root/src"
  git -C "$root" init --quiet --initial-branch=main
  git -C "$root" config user.email demo@example.invalid
  git -C "$root" config user.name demo
  printf 'export const base = 1;\n' >"$root/src/base.ts"
  printf 'approved plan\n' >"$root/plan.md"
  git -C "$root" add .
  git -C "$root" commit --quiet -m base
}

# Wait for the seat's launch receipt, then show the pane the daemon opened and the readiness
# sidecar the stub runner wrote into its candidate tree: the launch is real, only the client is a
# stub. The replay projection withholds the event body, so the receipt's existence is the evidence.
launch_receipt() {
  local run_id="$1" seat="$2"
  for _ in $(seq 1 120); do
    if curl --noproxy "*" -fsS "$BASE/api/team-control/runs/$run_id/replay?limit=1000" \
      -H "Authorization: Bearer $MULTI_AGENT_OWNER_TOKEN" | grep -q 'managed.attempt.receipt'; then
      echo "receipt: managed.attempt.receipt"
      TMUX_TMPDIR="$TMUX_TMPDIR" tmux list-panes -t "=$seat:" -F 'pane: #{pane_id} #{pane_current_command} #{pane_current_path}'
      node -e '
const fs = require("fs"), path = require("path");
const walk = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
  const child = path.join(dir, entry.name);
  if (entry.isDirectory()) walk(child);
  else if (child.endsWith(path.join(".openrig", "stub", "state.json"))) console.log("runner: " + fs.readFileSync(child, "utf8"));
} };
walk(process.argv[1]);' "$OPENRIG_HOME/state/workers/assignments"
      return 0
    fi
    sleep 0.5
  done
  echo "error: no launch receipt was recorded for run $run_id" >&2
  TMUX_TMPDIR="$TMUX_TMPDIR" tmux list-sessions 2>/dev/null >&2 || true
  cat "$SCRATCH/daemon.log" >&2
  return 1
}

start_run() {
  local goal="$1" rig="$2" start run_id seat
  start="$("${RIG[@]}" team start "$goal" --rig "$rig")"
  printf '%s\n' "$start"
  run_id="$(printf '%s' "$start" | sed -n 's/^Run:  \(.*\)$/\1/p')"
  seat="$(printf '%s' "$start" | sed -n 's/^Task: .* on \(.*\)$/\1/p')"
  [ -n "$run_id" ] && [ -n "$seat" ] || { echo "error: no run id or seat in the start receipt" >&2; return 1; }
  printf 'seat: %s\n' "$seat"
  launch_receipt "$run_id" "$seat"
}

echo "==> A scratch repository for the team"
PROJECT="$SCRATCH/work/project"
repository "$PROJECT"

echo "==> Booting the demo daemon (stub runner, managed mode)"
npx tsx demo/team/scripts/demo-daemon.ts >"$SCRATCH/daemon.log" 2>&1 &
DAEMON_PID=$!
for _ in $(seq 1 120); do
  if curl --noproxy "*" -fsS "$BASE/healthz" >/dev/null 2>&1; then break; fi
  sleep 0.5
done
curl --noproxy "*" -fsS "$BASE/healthz" >/dev/null || { echo "error: the daemon did not become healthy" >&2; cat "$SCRATCH/daemon.log" >&2; exit 1; }

echo "==> rig team create (the default team: lead, two implementers, reviewer)"
"${RIG[@]}" team create "$PROJECT"

echo "==> rig team start (the run lands on the team's lead seat)"
start_run "Say hello from the created team" project

echo "==> A second team with only an implementer seat, created through the endpoint"
PROJECT_IMPL="$SCRATCH/work/impl-project"
repository "$PROJECT_IMPL"
curl --noproxy "*" -fsS -X POST "$BASE/api/team-control/teams" \
  -H "Authorization: Bearer $MULTI_AGENT_OWNER_TOKEN" -H "Content-Type: application/json" \
  -d "{\"repository\":\"$PROJECT_IMPL\",\"seats\":[{\"role\":\"implementer\",\"client\":\"claude-code\"}]}"
echo

echo "==> rig team start (the run lands on that team's implementer seat)"
start_run "Implement the assigned module" impl-project

echo "==> The teams that exist"
curl --noproxy "*" -fsS "$BASE/api/team-control/teams" -H "Authorization: Bearer $MULTI_AGENT_OWNER_TOKEN" \
  | node -e '
const { teams } = JSON.parse(require("fs").readFileSync(0, "utf8"));
for (const team of teams) {
  console.log(team.name + "  " + team.repository);
  for (const seat of team.seats) console.log("  " + seat.role.padEnd(12) + " " + seat.client);
}'

echo "==> Done. The daemon this script started stops when the script exits."
