#!/usr/bin/env bash
# Start the daemon in managed mode using the owner token that ./setup.sh created.
# Workers run as your own user (config `workers.isolation: none`), so no sudo is needed.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OWNER_ENV="${XDG_CONFIG_HOME:-$HOME/.config}/multi-agent/owner.env"

[ -f "$OWNER_ENV" ] || {
  echo "error: $OWNER_ENV is missing. Run ./setup.sh first." >&2
  exit 1
}

set -a
# shellcheck disable=SC1090
. "$OWNER_ENV"
set +a

# A managed daemon refuses any listener that is not loopback, so ask for loopback.
exec "$REPO_ROOT/engine/node_modules/.bin/rig" daemon start --host 127.0.0.1