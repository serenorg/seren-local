#!/usr/bin/env bash
# ABOUTME: Cross-platform install script for Seren local runtime (macOS/Linux).
# ABOUTME: Checks Node.js, installs @serendb/runtime globally via npm.
#
# Usage: curl -fsSL https://seren.com/install | sh

set -euo pipefail

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
RESET='\033[0m'

MIN_NODE_MAJOR=20
PACKAGE="@serendb/runtime"

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

# ── Check Node.js ──────────────────────────────────────────────────────
check_node() {
  if ! command -v node &>/dev/null; then
    return 1
  fi

  local version
  version=$(node --version 2>/dev/null | sed 's/^v//')
  local major
  major=$(echo "$version" | cut -d. -f1)

  if [ "$major" -lt "$MIN_NODE_MAJOR" ]; then
    error "Node.js v${version} found, but v${MIN_NODE_MAJOR}+ required."
    return 1
  fi

  ok "Node.js v${version} found"
  return 0
}

install_node_instructions() {
  error "Node.js v${MIN_NODE_MAJOR}+ is required but not found."
  printf "\n"
  info "Install Node.js using one of these methods:"
  printf "\n"

  case "$(uname -s)" in
    Darwin*)
      echo "  brew install node"
      echo "  # or visit https://nodejs.org"
      ;;
    Linux*)
      echo "  # Ubuntu/Debian:"
      echo "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -"
      echo "  sudo apt-get install -y nodejs"
      echo ""
      echo "  # or use nvm:"
      echo "  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash"
      echo "  nvm install 22"
      ;;
  esac

  printf "\n"
  echo "Then re-run this installer:"
  echo "  curl -fsSL https://seren.com/install | sh"
  printf "\n"
  exit 1
}

# ── Check npm ──────────────────────────────────────────────────────────
check_npm() {
  if ! command -v npm &>/dev/null; then
    error "npm not found. It should come with Node.js."
    error "Please reinstall Node.js from https://nodejs.org"
    exit 1
  fi
  ok "npm $(npm --version) found"
}

# ── Check native build toolchain ──────────────────────────────────────
check_toolchain() {
  case "$(uname -s)" in
    Darwin*)
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
    Linux*)
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

  # Use npm global install. If permission denied, suggest --prefix or sudo.
  if npm install -g "${PACKAGE}" 2>&1; then
    printf "\n"
    ok "${PACKAGE} installed successfully!"
  else
    printf "\n"
    warn "Global install failed (likely a permissions issue)."
    printf "\n"
    info "Try one of these:"
    echo "  # Option 1: Use sudo"
    echo "  sudo npm install -g ${PACKAGE}"
    echo ""
    echo "  # Option 2: Fix npm permissions (recommended)"
    echo "  mkdir -p ~/.npm-global"
    echo "  npm config set prefix ~/.npm-global"
    echo "  echo 'export PATH=~/.npm-global/bin:\$PATH' >> ~/.bashrc"
    echo "  source ~/.bashrc"
    echo "  npm install -g ${PACKAGE}"
    printf "\n"
    exit 1
  fi
}

# ── Verify installation ───────────────────────────────────────────────
verify_install() {
  if command -v seren &>/dev/null; then
    ok "seren command is available"
  else
    warn "seren command not found in PATH."
    warn "You may need to add npm global bin to your PATH:"
    echo "  export PATH=\"\$(npm prefix -g)/bin:\$PATH\""
  fi
}

# ── Create data directory ──────────────────────────────────────────────
create_data_dir() {
  local data_dir="${HOME}/.seren"
  if [ ! -d "$data_dir" ]; then
    mkdir -p "$data_dir"
    ok "Created ${data_dir}/"
  fi
}

# ── Main ───────────────────────────────────────────────────────────────
main() {
  check_node || install_node_instructions
  check_npm
  check_toolchain
  install_runtime
  verify_install
  create_data_dir

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
}

main
