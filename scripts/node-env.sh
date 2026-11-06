# Sourced by setup.sh, start.sh and the desktop app's commands. It puts a supported
# Node.js (22 or 24) first on PATH.
#
# The desktop app runs these scripts through a non-interactive login shell. Such a
# shell never reaches the part of ~/.bashrc where nvm, fnm and similar managers put
# themselves on PATH, so `node` is missing even on a machine where it works in a
# terminal. This script checks the usual install locations instead.

case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) PATH="$HOME/.local/bin:$PATH"; export PATH ;;
esac

_ma_node_ok() {
  [ -x "$1/node" ] || return 1
  case "$("$1/node" -p 'process.versions.node.split(".")[0]' 2>/dev/null)" in
    22 | 24) return 0 ;;
    *) return 1 ;;
  esac
}

_ma_node_dir() {
  local candidate dir
  if candidate="$(command -v node 2>/dev/null)"; then
    dir="$(dirname "$candidate")"
    _ma_node_ok "$dir" && { printf '%s' "$dir"; return 0; }
  fi
  # Newest version first, so a machine with several installs uses the latest supported one.
  for dir in $(ls -1d \
      "${NVM_DIR:-$HOME/.nvm}"/versions/node/v2[24].*/bin \
      "${FNM_DIR:-$HOME/.local/share/fnm}"/node-versions/v2[24].*/installation/bin \
      2>/dev/null | sort -rV) \
      "${VOLTA_HOME:-$HOME/.volta}/bin" \
      "$HOME/.local/bin" \
      /usr/local/bin \
      /opt/multi-agent/toolchain/node/bin; do
    _ma_node_ok "$dir" && { printf '%s' "$dir"; return 0; }
  done
  return 1
}

if _ma_node_bin="$(_ma_node_dir)"; then
  case ":$PATH:" in
    *":$_ma_node_bin:"*) ;;
    *) PATH="$_ma_node_bin:$PATH"; export PATH ;;
  esac
fi
unset -f _ma_node_ok _ma_node_dir
unset _ma_node_bin
