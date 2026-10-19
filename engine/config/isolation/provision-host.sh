#!/usr/bin/env bash
# Owner-run provisioning for the restricted worker boundary (U1).
#
#   sudo bash engine/config/isolation/provision-host.sh [--preflight-owner <login>]
#        [--egress-upstream http://host:port] [--egress-allow host:port]...
#
# Installs a pinned, root-owned toolchain and native clients, creates the
# control, egress and worker identities, lays out state directories, installs
# the launcher, policy and worker egress filter (KTD23) from this directory, and
# grants the control identity exactly one sudo command: the launcher.
# --preflight-owner additionally lets that login act as the control/worker
# identities without a password so the preflight harness can stage sentinels;
# remove it after preflight. --egress-upstream and --egress-allow write the
# machine-local /etc/multi-agent/egress.json (never the repository); without
# them a re-run keeps the installed values.
# First framework install takes MA_FRAMEWORK_ARCHIVE and MA_FRAMEWORK_ARCHIVE_SHA256:
# an owner-verified git archive of the catalog pin, with --prefix=framework/.
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

EGRESS="ma-egress"
EGRESS_CONFIG="$ETC_DIR/egress.json"
EGRESS_UNIT="/etc/systemd/system/multi-agent-egress.service"
# Public provider and registry endpoints; owner gateways are added with --egress-allow.
EGRESS_DEFAULT_ALLOW="api.anthropic.com:443 api.openai.com:443 chatgpt.com:443 registry.npmjs.org:443"

SRC_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
PREFLIGHT_OWNER=""
EGRESS_UPSTREAM=""
EGRESS_UPSTREAM_SET=0
EGRESS_EXTRA=""

while [ $# -gt 0 ]; do
  case "$1" in
    --preflight-owner) PREFLIGHT_OWNER="${2:?--preflight-owner needs a login}"; shift 2 ;;
    --egress-upstream) EGRESS_UPSTREAM="${2?--egress-upstream needs a URL, or '' for direct}"; EGRESS_UPSTREAM_SET=1; shift 2 ;;
    --egress-allow) EGRESS_EXTRA="$EGRESS_EXTRA ${2:?--egress-allow needs host:port}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

log() { printf '[provision] %s\n' "$*"; }
die() { printf '[provision] ERROR %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run with sudo"
grep -q '^ID=ubuntu' /etc/os-release || die "Ubuntu is required"
grep -qi microsoft /proc/sys/kernel/osrelease || die "WSL2 kernel is required"
[ -f "$SRC_DIR/worker-launch.mjs" ] && [ -f "$SRC_DIR/worker-policy.json" ] && [ -f "$SRC_DIR/egress.mjs" ] || die "launcher sources missing in $SRC_DIR"
[ "$(ps -p 1 -o comm=)" = "systemd" ] || die "systemd is required to run the worker egress filter (set [boot] systemd=true in /etc/wsl.conf)"
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
# Managed Codex launches read this catalog. It is the pinned client's bundled catalog with
# use_responses_lite off: the lite request shape carries tools and instructions in an
# `additional_tools` input item, which a relay gateway drops, leaving the model with no shell.
codex_home="$(mktemp -d)"
CODEX_HOME="$codex_home" PATH="$CLIENT_PATH" codex debug models --bundled \
  | "$NODE" -e '
    let raw = ""; process.stdin.on("data", d => raw += d).on("end", () => {
      const catalog = JSON.parse(raw);
      if (!Array.isArray(catalog.models) || catalog.models.length === 0) throw new Error("empty bundled Codex catalog");
      for (const model of catalog.models) model.use_responses_lite = false;
      process.stdout.write(JSON.stringify(catalog, null, 2) + "\n");
    });' > "$TOOLCHAIN/clients/codex-model-catalog.json.new" \
  || die "could not derive the managed Codex model catalog"
rm -rf "$codex_home"
install -o root -g root -m 0644 "$TOOLCHAIN/clients/codex-model-catalog.json.new" "$TOOLCHAIN/clients/codex-model-catalog.json"
rm -f "$TOOLCHAIN/clients/codex-model-catalog.json.new"
# The egress filter lives in the toolchain, which every sandbox already mounts read-only.
install -d -o root -g root -m 0755 "$TOOLCHAIN/egress"
install -o root -g root -m 0644 "$SRC_DIR/egress.mjs" "$TOOLCHAIN/egress/egress.mjs"
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
ensure_user "$EGRESS" "/nonexistent"
for w in "${WORKERS[@]}"; do ensure_user "$w" "$STATE_ROOT/workers/$w/home"; done

log "laying out state directories"
install -d -o root -g root -m 0755 "$STATE_ROOT"
install -d -o "$CONTROL" -g "$CONTROL" -m 0700 "$STATE_ROOT/control"
MAILBOX_ROOT="$("$NODE" -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$SRC_DIR/worker-policy.json','utf8')).paths.mailbox_root)")"
[ "$MAILBOX_ROOT" = "$STATE_ROOT/control/mailboxes" ] && [ ! -L "$MAILBOX_ROOT" ] || die "mailbox root must be the fixed private control directory"
install -d -o "$CONTROL" -g "$CONTROL" -m 0700 "$MAILBOX_ROOT"
install -d -o root -g root -m 0711 "$STATE_ROOT/workers" "$STATE_ROOT/assignments"
CONTEXT_ROOT="$("$NODE" -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$SRC_DIR/worker-policy.json','utf8')).paths.context_root)")"
[ ! -L "$CONTEXT_ROOT" ] || die "context root must not be a symlink"
install -d -o root -g root -m 0755 "$CONTEXT_ROOT"
for w in "${WORKERS[@]}"; do
  [ ! -L "$CONTEXT_ROOT/$w" ] || die "worker context directory must not be a symlink"
  # Setgid and a default ACL give control-created projections this worker's group and
  # read/search access even when the control process has umask 077.
  install -d -o "$CONTROL" -g "$w" -m 2750 "$CONTEXT_ROOT/$w"
  setfacl -b -k "$CONTEXT_ROOT/$w"
  setfacl -m "u::rwx,g::r-x,m::r-x,o::---" "$CONTEXT_ROOT/$w"
  setfacl -m "d:u::rwx,d:g::r-x,d:m::r-x,d:o::---" "$CONTEXT_ROOT/$w"
  install -d -o "$w" -g "$w" -m 0700 "$STATE_ROOT/workers/$w" "$STATE_ROOT/workers/$w/home" "$STATE_ROOT/workers/$w/scratch"
  # Control stages trees here; the worker owns and edits them.
  install -d -o "$w" -g "$CONTROL" -m 2770 "$STATE_ROOT/assignments/$w"
  setfacl -m "u:$w:rwx,g:$CONTROL:rwx" -m "d:u:$w:rwx,d:g:$CONTROL:rwx,d:o::---" "$STATE_ROOT/assignments/$w"
done

log "verifying the pinned read-only framework"
SRC_DIR="$SRC_DIR" python3 - <<'PYFRAMEWORK'
import hashlib, json, os, posixpath, re, shutil, tarfile, tempfile
from pathlib import Path, PurePosixPath

source = Path(os.environ["SRC_DIR"])
policy = json.loads((source / "worker-policy.json").read_text())
destination = Path(policy["paths"]["framework_dir"])
catalog = source.parents[1] / "packages/daemon/src/integrations/framework/catalog.ts"
revision = re.search(r'revision: "([a-f0-9]{40})"', catalog.read_text()).group(1)
receipt_name = ".framework-receipt.json"

def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()

def verify(root):
    receipt = json.loads((root / receipt_name).read_text())
    if receipt["revision"] != revision:
        raise RuntimeError("installed framework revision differs from the catalog pin")
    expected = receipt["files"]
    actual = {str(p.relative_to(root)) for p in root.rglob("*") if p.is_symlink() or not p.is_dir()}
    if actual != set(expected) | {receipt_name}:
        raise RuntimeError("installed framework file set differs from its receipt")
    for relative, facts in expected.items():
        path = root / relative
        if path.lstat().st_uid != 0:
            raise RuntimeError("framework source is not root-owned")
        if "link" in facts:
            if not path.is_symlink() or os.readlink(path) != facts["link"] or not path.resolve().is_relative_to(root):
                raise RuntimeError("framework link changed or escaped")
        elif path.is_symlink() or digest(path) != facts["sha256"] or (path.stat().st_mode & 0o777) != facts["mode"]:
            raise RuntimeError("framework source bytes or permissions changed")
    for path in [root, *root.rglob("*")]:
        if not path.is_symlink() and (path.stat().st_uid != 0 or path.stat().st_mode & 0o222):
            raise RuntimeError("framework tree is not root-owned and read-only")

if destination.is_symlink() or destination.parent.resolve() != destination.parent:
    raise RuntimeError("framework destination must not be aliased")
if destination.exists():
    verify(destination)
else:
    archive = os.environ.get("MA_FRAMEWORK_ARCHIVE", "")
    expected_hash = os.environ.get("MA_FRAMEWORK_ARCHIVE_SHA256", "")
    if not archive or not re.fullmatch(r"[a-f0-9]{64}", expected_hash):
        raise RuntimeError("first framework install needs an owner-verified archive and SHA-256")
    with open(archive, "rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != expected_hash:
            raise RuntimeError("framework archive checksum mismatch")
        stream.seek(0)
        with tarfile.open(fileobj=stream, mode="r:") as bundle:
            if bundle.pax_headers.get("comment") != revision:
                raise RuntimeError("framework archive does not identify the catalog pin")
            entries = {}
            for member in bundle.getmembers():
                name = member.name.rstrip("/")
                if name == "framework" and member.isdir():
                    continue
                if not name.startswith("framework/") or not (member.isfile() or member.isdir() or member.issym()):
                    raise RuntimeError("unsupported framework archive entry")
                relative = name[len("framework/"):]
                if not relative or PurePosixPath(relative).is_absolute() or ".." in PurePosixPath(relative).parts or posixpath.normpath(relative) != relative or relative in entries or relative == receipt_name:
                    raise RuntimeError("framework archive path is not contained and unique")
                entries[relative] = member
            for relative, member in entries.items():
                if any(str(parent) in entries and entries[str(parent)].issym() for parent in PurePosixPath(relative).parents):
                    raise RuntimeError("framework archive traverses a link")
                if member.issym():
                    target = posixpath.normpath(posixpath.join(posixpath.dirname(relative), member.linkname))
                    if posixpath.isabs(member.linkname) or target not in entries or entries[target].issym() or any(str(parent) in entries and entries[str(parent)].issym() for parent in PurePosixPath(target).parents):
                        raise RuntimeError("framework link escapes or traverses another link")
            with tempfile.TemporaryDirectory(prefix=".framework-stage-", dir=destination.parent) as temporary:
                stage = Path(temporary)
                files = {}
                for relative, member in entries.items():
                    path = stage / relative
                    path.parent.mkdir(parents=True, exist_ok=True)
                    if member.isdir():
                        path.mkdir(exist_ok=True)
                    elif member.isfile():
                        with bundle.extractfile(member) as incoming, path.open("xb") as outgoing:
                            shutil.copyfileobj(incoming, outgoing)
                        mode = 0o555 if member.mode & 0o111 else 0o444
                        path.chmod(mode)
                        files[relative] = {"sha256": digest(path), "mode": mode}
                for relative, member in entries.items():
                    if member.issym():
                        (stage / relative).symlink_to(member.linkname)
                        files[relative] = {"link": member.linkname}
                receipt = {"revision": revision, "archive_sha256": expected_hash, "files": files}
                (stage / receipt_name).write_text(json.dumps(receipt, sort_keys=True) + "\n")
                (stage / receipt_name).chmod(0o444)
                for path in sorted([p for p in stage.rglob("*") if p.is_dir() and not p.is_symlink()], key=lambda p: len(p.parts), reverse=True):
                    path.chmod(0o555)
                stage.chmod(0o555)
                stage.rename(destination)
    verify(destination)
print("pinned framework verified")
PYFRAMEWORK

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

log "installing the worker egress filter (KTD23)"
# Machine-local: the owner's upstream proxy and gateway hosts stay out of the repository.
EGRESS_UPSTREAM_SET="$EGRESS_UPSTREAM_SET" EGRESS_UPSTREAM="$EGRESS_UPSTREAM" EGRESS_EXTRA="$EGRESS_EXTRA" \
EGRESS_DEFAULT_ALLOW="$EGRESS_DEFAULT_ALLOW" EGRESS_CONFIG="$EGRESS_CONFIG" "$NODE" --input-type=module -e "
  import { existsSync, readFileSync, writeFileSync } from 'node:fs';
  const { validateEgressConfig, EGRESS_SCHEMA } = await import('$TOOLCHAIN/egress/egress.mjs');
  const env = process.env;
  const current = existsSync(env.EGRESS_CONFIG) ? JSON.parse(readFileSync(env.EGRESS_CONFIG, 'utf8')) : null;
  const upstream = env.EGRESS_UPSTREAM_SET === '1' ? (env.EGRESS_UPSTREAM || null) : (current?.upstream ?? null);
  const extra = env.EGRESS_EXTRA.trim() ? env.EGRESS_EXTRA.trim().split(/\s+/) : (current?.allow ?? []);
  const allow = [...new Set([...env.EGRESS_DEFAULT_ALLOW.split(' '), ...extra])].sort();
  const config = { schema: EGRESS_SCHEMA, upstream, allow };
  validateEgressConfig(config);
  writeFileSync(env.EGRESS_CONFIG + '.new', JSON.stringify(config, null, 2) + '\n', { mode: 0o644 });
" || die "egress configuration is invalid"
# Holds no credentials; the preflight reads it to fingerprint the egress profile.
install -o root -g root -m 0644 "$EGRESS_CONFIG.new" "$EGRESS_CONFIG"
rm -f "$EGRESS_CONFIG.new"
EGRESS_SOCKET_DIR="$("$NODE" -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$ETC_DIR/worker-policy.json','utf8')).paths.egress_socket_dir)")"
[[ "$EGRESS_SOCKET_DIR" =~ ^/run/[a-z0-9][a-z0-9-]{0,63}$ ]] || die "egress socket dir must be /run/<name>"
# With a literal-IP upstream the filter itself may reach only that address.
EGRESS_IP_RULES=""
EGRESS_UPSTREAM_HOST="$("$NODE" -e "const c=JSON.parse(require('fs').readFileSync('$EGRESS_CONFIG','utf8'));process.stdout.write(c.upstream?new URL(c.upstream).hostname.replace(/^\[|\]$/g,''):'')")"
if [ -n "$EGRESS_UPSTREAM_HOST" ] && "$NODE" -e "process.exit(require('net').isIP('$EGRESS_UPSTREAM_HOST')?0:1)"; then
  EGRESS_IP_RULES="IPAddressDeny=any
IPAddressAllow=$EGRESS_UPSTREAM_HOST"
fi
cat > "$EGRESS_UNIT.new" <<EOF
[Unit]
Description=Multi-agent worker egress filter (KTD23)
After=network.target

[Service]
User=$EGRESS
Group=$EGRESS
RuntimeDirectory=${EGRESS_SOCKET_DIR#/run/}
RuntimeDirectoryMode=0755
# Live sandboxes bind this directory; a stop or restart must keep its inode.
RuntimeDirectoryPreserve=yes
TimeoutStopSec=5
ExecStart=$NODE $TOOLCHAIN/egress/egress.mjs serve $EGRESS_SOCKET_DIR/proxy.sock $EGRESS_CONFIG
Restart=on-failure
$EGRESS_IP_RULES
SystemCallFilter=@system-service
SystemCallArchitectures=native
RestrictNamespaces=yes
ProtectProc=invisible
ProtectHostname=yes
ProtectClock=yes
RestrictRealtime=yes
TasksMax=64
MemoryMax=512M
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
# AF_NETLINK: direct mode reads this host's interface addresses to refuse them.
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
RestrictSUIDSGID=yes
LockPersonality=yes
UMask=0022

[Install]
WantedBy=multi-user.target
EOF
install -o root -g root -m 0644 "$EGRESS_UNIT.new" "$EGRESS_UNIT"
rm -f "$EGRESS_UNIT.new"
systemctl daemon-reload
systemctl enable --quiet multi-agent-egress.service
systemctl restart multi-agent-egress.service
for _ in $(seq 1 50); do [ -S "$EGRESS_SOCKET_DIR/proxy.sock" ] && break; sleep 0.1; done
[ -S "$EGRESS_SOCKET_DIR/proxy.sock" ] || { systemctl --no-pager status multi-agent-egress.service >&2 || true; die "egress filter did not start"; }

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
  "$TOOLCHAIN/egress/egress.mjs" "$EGRESS_CONFIG" "$EGRESS_UNIT" \
  $( [ -n "$PREFLIGHT_OWNER" ] && echo "$SUDOERS_PREFLIGHT" )
"$NODE" -v
PATH="$CLIENT_PATH" claude --version
PATH="$CLIENT_PATH" codex --version
log "done"
