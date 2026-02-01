#!/usr/bin/env bash
# ABOUTME: Cross-platform install script for Seren local runtime (macOS/Linux).
# ABOUTME: Auto-downloads Node.js if missing, installs @serendb/runtime into ~/.seren.
#
# Usage: curl -fsSL https://seren.com/install | sh

set -euo pipefail

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
RESET='\033[0m'

NODE_VERSION="22.13.1"
MIN_NODE_MAJOR=20
PACKAGE="@serendb/runtime"
SEREN_DIR="${HOME}/.seren"
SEREN_NODE_DIR="${SEREN_DIR}/node"
SEREN_BIN="${SEREN_DIR}/bin"

info()  { printf "${BOLD}%s${RESET}\n" "$*"; }
ok()    { printf "${GREEN}✓ %s${RESET}\n" "$*"; }
warn()  { printf "${YELLOW}! %s${RESET}\n" "$*"; }
error() { printf "${RED}✗ %s${RESET}\n" "$*" >&2; }

# ── Banner ─────────────────────────────────────────────────────────────
printf "\n"
info "╔══════════════════════════════════════════╗"
info "║       Seren Runtime Installer            ║"
info "║  Local AI agents, MCP, and file access   ║"
info "╚══════════════════════════════════════════╝"
printf "\n"

# ── Detect platform ───────────────────────────────────────────────────
detect_platform() {
  local os arch
  os=$(uname -s)
  arch=$(uname -m)

  case "$os" in
    Darwin*) OS="darwin" ;;
    Linux*)  OS="linux" ;;
    *)       error "Unsupported OS: $os"; exit 1 ;;
  esac

  case "$arch" in
    x86_64|amd64)  ARCH="x64" ;;
    arm64|aarch64) ARCH="arm64" ;;
    *)             error "Unsupported architecture: $arch"; exit 1 ;;
  esac

  ok "Detected ${OS}-${ARCH}"
}

# ── Check for system Node.js ──────────────────────────────────────────
check_system_node() {
  # Check Seren's private Node first, then system Node
  if [ -x "${SEREN_NODE_DIR}/bin/node" ]; then
    local version
    version=$("${SEREN_NODE_DIR}/bin/node" --version 2>/dev/null | sed 's/^v//')
    local major
    major=$(echo "$version" | cut -d. -f1)
    if [ "$major" -ge "$MIN_NODE_MAJOR" ]; then
      NODE_BIN="${SEREN_NODE_DIR}/bin/node"
      NPM_BIN="${SEREN_NODE_DIR}/bin/npm"
      ok "Seren Node.js v${version} found"
      return 0
    fi
  fi

  if command -v node &>/dev/null; then
    local version
    version=$(node --version 2>/dev/null | sed 's/^v//')
    local major
    major=$(echo "$version" | cut -d. -f1)
    if [ "$major" -ge "$MIN_NODE_MAJOR" ]; then
      NODE_BIN="node"
      NPM_BIN="npm"
      ok "System Node.js v${version} found"
      return 0
    fi
    warn "System Node.js v${version} too old (need v${MIN_NODE_MAJOR}+)."
  fi

  return 1
}

# ── Download Node.js ──────────────────────────────────────────────────
install_node() {
  info "Downloading Node.js v${NODE_VERSION} for ${OS}-${ARCH}..."

  local url="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${OS}-${ARCH}.tar.gz"
  local tmp_tar
  tmp_tar=$(mktemp "${TMPDIR:-/tmp}/seren-node-XXXXXX.tar.gz")

  # Download
  if command -v curl &>/dev/null; then
    curl -fsSL "$url" -o "$tmp_tar"
  elif command -v wget &>/dev/null; then
    wget -qO "$tmp_tar" "$url"
  else
    error "Neither curl nor wget found. Cannot download Node.js."
    exit 1
  fi

  # Extract to ~/.seren/node/
  mkdir -p "$SEREN_NODE_DIR"
  tar xzf "$tmp_tar" -C "$SEREN_NODE_DIR" --strip-components=1
  rm -f "$tmp_tar"

  NODE_BIN="${SEREN_NODE_DIR}/bin/node"
  NPM_BIN="${SEREN_NODE_DIR}/bin/npm"

  local installed_version
  installed_version=$("$NODE_BIN" --version 2>/dev/null)
  ok "Installed Node.js ${installed_version} to ${SEREN_NODE_DIR}/"
}

# ── Check native build toolchain ──────────────────────────────────────
check_toolchain() {
  case "$OS" in
    darwin)
      if ! xcode-select -p &>/dev/null; then
        warn "Xcode Command Line Tools not found."
        warn "The runtime uses a native SQLite module that requires a compiler."
        printf "\n"
        info "Install with:"
        echo "  xcode-select --install"
        printf "\n"
        info "Then re-run this installer."
        exit 1
      fi
      ok "Xcode Command Line Tools found"
      ;;
    linux)
      if ! command -v make &>/dev/null || ! command -v g++ &>/dev/null; then
        warn "Build tools (make, g++) not found."
        warn "The runtime uses a native SQLite module that requires a compiler."
        printf "\n"
        info "Install with:"
        echo "  sudo apt-get install -y build-essential python3"
        echo "  # or on Fedora/RHEL:"
        echo "  sudo dnf groupinstall 'Development Tools'"
        printf "\n"
        info "Then re-run this installer."
        exit 1
      fi
      ok "Build toolchain found"
      ;;
  esac
}

# ── Install runtime ────────────────────────────────────────────────────
install_runtime() {
  info "Installing ${PACKAGE}..."
  printf "\n"

  # Install into Seren's private prefix so no sudo is needed
  mkdir -p "$SEREN_BIN"
  "$NPM_BIN" install -g "${PACKAGE}" --prefix "${SEREN_DIR}" 2>&1

  printf "\n"
  ok "${PACKAGE} installed successfully!"
}

# ── Set up PATH ───────────────────────────────────────────────────────
setup_path() {
  local path_line="export PATH=\"${SEREN_BIN}:\$PATH\""
  local shell_name
  shell_name=$(basename "${SHELL:-/bin/bash}")

  # Determine rc file
  local rc_file
  case "$shell_name" in
    zsh)  rc_file="${HOME}/.zshrc" ;;
    fish) rc_file="${HOME}/.config/fish/config.fish" ;;
    *)    rc_file="${HOME}/.bashrc" ;;
  esac

  # Fish uses different syntax
  if [ "$shell_name" = "fish" ]; then
    path_line="set -gx PATH ${SEREN_BIN} \$PATH"
  fi

  # Add to rc file if not already present
  if [ -f "$rc_file" ] && grep -qF "${SEREN_BIN}" "$rc_file" 2>/dev/null; then
    ok "PATH already configured in ${rc_file}"
  else
    printf "\n# Seren runtime\n%s\n" "$path_line" >> "$rc_file"
    ok "Added ${SEREN_BIN} to PATH in ${rc_file}"
  fi

  # Also make it available in this session
  export PATH="${SEREN_BIN}:${PATH}"
}

# ── Verify installation ───────────────────────────────────────────────
verify_install() {
  if [ -x "${SEREN_BIN}/seren" ] || command -v seren &>/dev/null; then
    ok "seren command is available"
  else
    # npm might place the bin in a different spot within the prefix
    local npm_bin_dir
    npm_bin_dir=$("$NPM_BIN" prefix -g 2>/dev/null)/bin
    if [ -x "${npm_bin_dir}/seren" ]; then
      # Symlink into our bin dir
      ln -sf "${npm_bin_dir}/seren" "${SEREN_BIN}/seren"
      ok "seren command is available"
    else
      warn "seren command not found. You may need to restart your terminal."
    fi
  fi
}

# ── Main ───────────────────────────────────────────────────────────────
main() {
  detect_platform
  check_system_node || install_node
  check_toolchain
  install_runtime
  setup_path
  verify_install

  printf "\n"
  info "╔══════════════════════════════════════════╗"
  info "║          Installation Complete!          ║"
  info "╚══════════════════════════════════════════╝"
  printf "\n"
  echo "  Start the runtime:"
  echo "    ${BOLD}seren${RESET}"
  printf "\n"
  echo "  Then open Seren in your browser:"
  echo "    ${BOLD}https://app.seren.com${RESET}"
  printf "\n"
  echo "  The browser will automatically connect to your local runtime."
  printf "\n"
  if [ -n "${SEREN_NODE_DIR:-}" ] && [ -x "${SEREN_NODE_DIR}/bin/node" ]; then
    echo "  Note: Node.js was installed to ${SEREN_NODE_DIR}/"
    echo "  To remove it, run: rm -rf ${SEREN_DIR}"
  fi
  printf "\n"
}

main
