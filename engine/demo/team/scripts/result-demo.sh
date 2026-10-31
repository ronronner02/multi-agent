#!/usr/bin/env bash
# One command that proves MVP slice 3 end to end, without a live client.
#
# Everything this script creates lives under one mktemp directory: the daemon's home and
# database, the tmux server the seat's pane lives on, and the scratch repositories. The
# trap removes all of it — and kills anything still running in it — on success and on
# failure alike, so a demo never leaves a stub runner, a tmux server or state behind.
#
# The variables must be exported before node starts: the daemon reads OPENRIG_HOME once, at
# module load, so setting them from inside the TypeScript file would be too late.
#
# Usage, from `engine/` after `npm run build`: bash demo/team/scripts/result-demo.sh
set -euo pipefail

ENGINE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ENGINE" || exit 1
export PATH="$ENGINE/node_modules/.bin:$PATH"

SCRATCH="$(mktemp -d)"
export OPENRIG_HOME="$SCRATCH/home"
export OPENRIG_DB="$SCRATCH/demo.sqlite"
export TMUX_TMPDIR="$SCRATCH/tmux"
mkdir -p "$OPENRIG_HOME" "$TMUX_TMPDIR"

cleanup() {
  # The seat's stub runner is a child of the pane; the tmux server is ours, so killing it
  # reaches every pane on it. Anything the server already lost is caught by the sweep below.
  TMUX_TMPDIR="$TMUX_TMPDIR" tmux kill-server 2>/dev/null || true
  pkill -f "stub-runner.js.*--cwd $SCRATCH" 2>/dev/null || true
  # A projection is sealed 0550 so the worker cannot write it; restore the bits before removal.
  chmod -R u+rwX "$SCRATCH" 2>/dev/null || true
  rm -rf "$SCRATCH"
}
trap cleanup EXIT INT TERM

npx tsx demo/team/scripts/result-demo.ts
