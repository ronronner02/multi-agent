#!/usr/bin/env bash
# One-command setup for a fresh clone: check prerequisites, install, build, and
# create the owner token once. Safe to run again; it never overwrites the token.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE="$REPO_ROOT/engine"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/multi-agent"
OWNER_ENV="$CONFIG_DIR/owner.env"

# shellcheck source=scripts/node-env.sh
. "$REPO_ROOT/scripts/node-env.sh"

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

command -v git >/dev/null || die "git is required. Install it with: sudo apt-get install git"
command -v tmux >/dev/null || die "tmux is required. Install it with: sudo apt-get install tmux"
command -v node >/dev/null || die "Node.js 22 or 24 is required and none was found on PATH, in nvm, fnm, Volta or /usr/local/bin. Install it with nvm: nvm install 22"
command -v npm >/dev/null || die "npm is required; it ships with Node.js."

node_major="$(node -p 'process.versions.node.split(".")[0]')"
case "$node_major" in
  22 | 24) ;;
  *) die "Node.js $node_major is not supported; this project needs 22 or 24. Install it with nvm: nvm install 22" ;;
esac

bash "$REPO_ROOT/scripts/install-gh.sh"

cd "$ENGINE"
npm ci --no-audit --no-fund
npm run build
# npm links a workspace bin only when its build output already exists, so a fresh
# clone's `npm ci` leaves `rig` unlinked. Relinking after the build fixes that.
npm rebuild -w packages/cli >/dev/null

if [ -f "$OWNER_ENV" ]; then
  echo "Keeping the existing owner token at $OWNER_ENV."
else
  umask 077
  mkdir -p "$CONFIG_DIR"
  token="$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')"
  printf 'MULTI_AGENT_MODE=managed\nMULTI_AGENT_OWNER_TOKEN=%s\n' "$token" >"$OWNER_ENV"
  chmod 600 "$OWNER_ENV"
  echo "Created the owner token at $OWNER_ENV (mode 600)."
fi

cat <<EOF

Setup complete. Next:

  export PATH="$ENGINE/node_modules/.bin:\$PATH"
  ./scripts/start.sh    # start the daemon in managed mode

EOF