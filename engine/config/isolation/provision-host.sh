#!/usr/bin/env bash
# Owner-run provisioning for the restricted worker boundary (U1).
#
#   sudo bash engine/config/isolation/provision-host.sh [--preflight-owner <login>]
#
# Installs a pinned, root-owned toolchain and native clients, creates the
# control and worker identities, lays out state directories, installs the
# launcher and policy from this directory, and grants the control identity
# exactly one sudo command: the launcher. --preflight-owner additionally lets
# that login act as the control/worker identities without a password so the
# preflight harness can stage sentinels; remove it after preflight.
# Re-running is idempotent. It never edits /etc/wsl.conf or Windows state.

set -euo pipefail

NODE_VERSION="v24.21.0"
NODE_SHA256="fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6"
CLAUDE_CODE_VERSION="2.1.296"
CODEX_VERSION="0.160.0"

CONTROL="ma-control"
WORKERS=(ma-worker1 ma-worker2 ma-worker3)
STATE_ROOT="/var/lib/multi-agent"
TOOLCHAIN="/opt/multi-agent/toolchain"
LIBEXEC="/usr/local/libexec/multi-agent"
ETC_DIR="/etc/multi-agent"
SUDOERS_LAUNCHER="/etc/sudoers.d/multi-agent-launcher"
SUDOERS_PREFLIGHT="/etc/sudoers.d/multi-agent-preflight"

SRC_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
PREFLIGHT_OWNER=""

while [ $# -gt 0 ]; do
  case "$1" in
    --preflight-owner) PREFLIGHT_OWNER="${2:?--preflight-owner needs a login}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

log() { printf '[provision] %s\n' "$*"; }
die() { printf '[provision] ERROR %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run with sudo"
grep -q '^ID=ubuntu' /etc/os-release || die "Ubuntu is required"
grep -qi microsoft /proc/sys/kernel/osrelease || die "WSL2 kernel is required"
[ -f "$SRC_DIR/worker-launch.mjs" ] && [ -f "$SRC_DIR/worker-policy.json" ] || die "launcher sources missing in $SRC_DIR"
if [ -n "$PREFLIGHT_OWNER" ]; then
  id "$PREFLIGHT_OWNER" >/dev/null 2>&1 || die "preflight owner $PREFLIGHT_OWNER does not exist"
fi

log "installing host packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends bubblewrap tmux util-linux socat acl curl xz-utils ca-certificates >/dev/null

log "installing Node.js $NODE_VERSION into $TOOLCHAIN/node"
install -d -o root -g root -m 0755 /opt/multi-agent "$TOOLCHAIN"
if [ "$("$TOOLCHAIN/node/bin/node" -v 2>/dev/null || true)" != "$NODE_VERSION" ]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  tarball="node-$NODE_VERSION-linux-x64.tar.xz"
  curl -fsSL -o "$tmp/$tarball" "https://nodejs.org/dist/$NODE_VERSION/$tarball"
  echo "$NODE_SHA256  $tmp/$tarball" | sha256sum -c --quiet - || die "Node.js tarball checksum mismatch"
  rm -rf "$TOOLCHAIN/node.new"
  install -d -m 0755 "$TOOLCHAIN/node.new"
  tar -xJf "$tmp/$tarball" -C "$TOOLCHAIN/node.new" --strip-components=1 --no-same-owner
  rm -rf "$TOOLCHAIN/node"
  mv "$TOOLCHAIN/node.new" "$TOOLCHAIN/node"
fi
NODE="$TOOLCHAIN/node/bin/node"
NPM="$TOOLCHAIN/node/bin/npm"

log "installing native clients (claude-code $CLAUDE_CODE_VERSION, codex $CODEX_VERSION)"
# Lifecycle scripts are disabled; the only one shipped (claude-code install.cjs,
# a local copy of the bundled platform binary) is run explicitly after install.
CLIENT_PATH="$TOOLCHAIN/clients/bin:$TOOLCHAIN/node/bin:/usr/bin:/bin"
if [ "$(PATH="$CLIENT_PATH" claude --version 2>/dev/null || true)" != "$CLAUDE_CODE_VERSION (Claude Code)" ] \
  || [ "$(PATH="$CLIENT_PATH" codex --version 2>/dev/null || true)" != "codex-cli $CODEX_VERSION" ]; then
  npm_cache="$(mktemp -d)"
  PATH="$TOOLCHAIN/node/bin:/usr/bin:/bin" "$NPM" install --global --prefix "$TOOLCHAIN/clients" \
    --ignore-scripts --no-audit --no-fund --cache "$npm_cache" \
    "@anthropic-ai/claude-code@$CLAUDE_CODE_VERSION" "@openai/codex@$CODEX_VERSION" >/dev/null
  rm -rf "$npm_cache"
  claude_pkg="$TOOLCHAIN/clients/lib/node_modules/@anthropic-ai/claude-code"
  (cd "$claude_pkg" && PATH="$TOOLCHAIN/node/bin:/usr/bin:/bin" "$NODE" install.cjs >/dev/null)
fi
chown -R root:root "$TOOLCHAIN"
chmod -R go-w "$TOOLCHAIN"

log "creating identities"
ensure_user() {
  local name="$1" home="$2"
  if ! id "$name" >/dev/null 2>&1; then
    useradd --system --user-group --no-create-home --home-dir "$home" --shell /usr/sbin/nologin "$name"
  fi
  # Workers and control hold no supplementary groups.
  usermod -G "" "$name"
}
ensure_user "$CONTROL" "$STATE_ROOT/control"
for w in "${WORKERS[@]}"; do ensure_user "$w" "$STATE_ROOT/workers/$w/home"; done

log "laying out state directories"
install -d -o root -g root -m 0755 "$STATE_ROOT"
install -d -o "$CONTROL" -g "$CONTROL" -m 0700 "$STATE_ROOT/control"
install -d -o root -g root -m 0711 "$STATE_ROOT/workers" "$STATE_ROOT/assignments"
for w in "${WORKERS[@]}"; do
  install -d -o "$w" -g "$w" -m 0700 "$STATE_ROOT/workers/$w" "$STATE_ROOT/workers/$w/home" "$STATE_ROOT/workers/$w/scratch"
  # Control stages trees here; the worker owns and edits them.
  install -d -o "$w" -g "$CONTROL" -m 2770 "$STATE_ROOT/assignments/$w"
  setfacl -m "u:$w:rwx,g:$CONTROL:rwx" -m "d:u:$w:rwx,d:g:$CONTROL:rwx,d:o::---" "$STATE_ROOT/assignments/$w"
done

log "installing launcher and policy"
install -d -o root -g root -m 0755 "$LIBEXEC" "$ETC_DIR"
install -o root -g root -m 0644 "$SRC_DIR/worker-policy.json" "$ETC_DIR/worker-policy.json"
install -o root -g root -m 0644 "$SRC_DIR/worker-launch.mjs" "$LIBEXEC/worker-launch.mjs"
cat > "$LIBEXEC/worker-launch.new" <<EOF
#!/bin/sh
exec /usr/bin/env -i SUDO_UID="\$SUDO_UID" PATH=/usr/bin:/bin "$NODE" "$LIBEXEC/worker-launch.mjs" "\$@"
EOF
install -o root -g root -m 0755 "$LIBEXEC/worker-launch.new" "$LIBEXEC/worker-launch"
rm -f "$LIBEXEC/worker-launch.new"
"$NODE" --input-type=module -e "
  import { readFileSync } from 'node:fs';
  const { validatePolicy } = await import('$LIBEXEC/worker-launch.mjs');
  validatePolicy(JSON.parse(readFileSync('$ETC_DIR/worker-policy.json', 'utf8')));
" || die "installed policy failed validation"

log "installing sudoers rules"
write_sudoers() {
  local dest="$1" body="$2" tmp
  tmp="$(mktemp)"
  printf '%s\n' "$body" > "$tmp"
  visudo -cqf "$tmp" || { rm -f "$tmp"; die "invalid sudoers content for $dest"; }
  install -o root -g root -m 0440 "$tmp" "$dest"
  rm -f "$tmp"
}
write_sudoers "$SUDOERS_LAUNCHER" "$CONTROL ALL=(root) NOPASSWD: $LIBEXEC/worker-launch"
if [ -n "$PREFLIGHT_OWNER" ]; then
  write_sudoers "$SUDOERS_PREFLIGHT" "$PREFLIGHT_OWNER ALL=($CONTROL,$(IFS=,; echo "${WORKERS[*]}")) NOPASSWD: ALL"
fi

log "installed artifacts"
sha256sum "$LIBEXEC/worker-launch" "$LIBEXEC/worker-launch.mjs" "$ETC_DIR/worker-policy.json" "$SUDOERS_LAUNCHER" \
  $( [ -n "$PREFLIGHT_OWNER" ] && echo "$SUDOERS_PREFLIGHT" )
"$NODE" -v
PATH="$CLIENT_PATH" claude --version
PATH="$CLIENT_PATH" codex --version
log "done"
