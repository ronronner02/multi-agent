#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=node-env.sh
. "$REPO_ROOT/scripts/node-env.sh"
command -v gh >/dev/null && exit 0

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
[ "$(uname -s)" = Linux ] || die "GitHub CLI setup supports Linux and WSL."
case "$(uname -m)" in
  x86_64) arch=amd64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) die "GitHub CLI setup needs an x86-64 or ARM64 machine." ;;
esac
for tool in node curl sha256sum tar gzip install; do
  command -v "$tool" >/dev/null || die "$tool is required to install GitHub CLI."
done

read -r version expected < <(node -e '
  const lock = require(process.argv[1]);
  console.log(lock.version, lock.linux[process.argv[2]]);
' "$REPO_ROOT/engine/config/toolchain/gh-lock.json" "$arch")
archive="gh_${version}_linux_${arch}.tar.gz"
temporary="$(mktemp -d)"
trap 'rm -rf -- "$temporary"' EXIT
curl --fail --silent --show-error --location --proto '=https' --connect-timeout 15 --max-time 120 \
  "https://github.com/cli/cli/releases/download/v${version}/$archive" -o "$temporary/$archive"
printf '%s  %s\n' "$expected" "$temporary/$archive" | sha256sum --check --status - \
  || die "GitHub CLI archive checksum does not match gh-lock.json."
tar -xzf "$temporary/$archive" -C "$temporary" "gh_${version}_linux_${arch}/bin/gh"
mkdir -p "$HOME/.local/bin"
install -m 755 "$temporary/gh_${version}_linux_${arch}/bin/gh" "$HOME/.local/bin/gh"
printf 'Installed GitHub CLI %s in %s/.local/bin.\n' "$version" "$HOME"
