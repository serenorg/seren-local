#!/usr/bin/env bash
# ABOUTME: Cross-platform install script for Seren local runtime (macOS/Linux).
# ABOUTME: Auto-downloads Node.js if missing, installs @serendb/runtime into ~/.seren-local.
#
# Usage: curl -fsSL https://serendb.com/install.sh | sh

set -euo pipefail

cleanup() {
  if [ -n "${SPINNER_PID:-}" ]; then
    kill "$SPINNER_PID" 2>/dev/null || true
    wait "$SPINNER_PID" 2>/dev/null || true
    printf "\r\033[K"
  fi
}
trap cleanup EXIT INT TERM

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
RESET='\033[0m'

NODE_VERSION="22.13.1"
MIN_NODE_MAJOR=20
PACKAGE="@serendb/serendesktop"
SEREN_DIR="${HOME}/.seren-local"
SEREN_NODE_DIR="${SEREN_DIR}/node"
SEREN_BIN="${SEREN_DIR}/bin"
SEREN_ICON_URL="https://raw.githubusercontent.com/serenorg/seren-local/main/scripts/assets/seren-icon.png"
SEREN_ICON_PATH=""
SCRIPT_SOURCE="${BASH_SOURCE[0]:-$0}"
if command -v realpath >/dev/null 2>&1; then
  SCRIPT_DIR=$(realpath "$(dirname "$SCRIPT_SOURCE")" 2>/dev/null)
else
  SCRIPT_DIR=$(cd "$(dirname "$SCRIPT_SOURCE")" >/dev/null 2>&1 && pwd || echo "")
fi

info()  { printf "${BOLD}%s${RESET}\n" "$*"; }
ok()    { printf "${GREEN}✓ %s${RESET}\n" "$*"; }
warn()  { printf "${YELLOW}! %s${RESET}\n" "$*"; }
error() { printf "${RED}✗ %s${RESET}\n" "$*" >&2; }

SPINNER_PID=""
spin() {
  local msg="$1"
  local show_elapsed="${2:-false}"
  local frames='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
  local i=0
  local start_time=$SECONDS
  while true; do
    if [ "$show_elapsed" = "true" ]; then
      local elapsed=$(( SECONDS - start_time ))
      local mins=$(( elapsed / 60 ))
      local secs=$(( elapsed % 60 ))
      printf "\r\033[K${BOLD}${frames:$i:1} %s (%dm %02ds)${RESET}" "$msg" "$mins" "$secs"
    else
      printf "\r\033[K${BOLD}${frames:$i:1} %s${RESET}" "$msg"
    fi
    i=$(( (i + 1) % ${#frames} ))
    sleep 0.1
  done
}

start_spinner() {
  spin "$1" "${2:-false}" &
  SPINNER_PID=$!
}

stop_spinner() {
  if [ -n "$SPINNER_PID" ]; then
    kill "$SPINNER_PID" 2>/dev/null || true
    wait "$SPINNER_PID" 2>/dev/null || true
    SPINNER_PID=""
    printf "\r\033[K"
  fi
}

# ── Icon + Shortcut Helpers ──────────────────────────────────────────

download_seren_icon() {
  local icon_dir="${SEREN_DIR}/share/icons"
  mkdir -p "$icon_dir"
  SEREN_ICON_PATH="${icon_dir}/seren-icon.png"

  if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/assets/seren-icon.png" ]; then
    cp "$SCRIPT_DIR/assets/seren-icon.png" "$SEREN_ICON_PATH"
    ok "Copied Seren icon"
    return
  fi

  if command -v curl >/dev/null 2>&1; then
    if curl -fsSL "$SEREN_ICON_URL" -o "$SEREN_ICON_PATH"; then
      ok "Downloaded Seren icon"
      return
    fi
  elif command -v wget >/dev/null 2>&1; then
    if wget -q "$SEREN_ICON_URL" -O "$SEREN_ICON_PATH"; then
      ok "Downloaded Seren icon"
      return
    fi
  fi

  warn "Unable to download Seren icon (desktop shortcut will use default icon)."
  SEREN_ICON_PATH=""
}

create_linux_shortcut() {
  local desktop_dir="${HOME}/Desktop"
  local applications_dir="${HOME}/.local/share/applications"
  [ -d "$desktop_dir" ] || desktop_dir="${HOME}"

  mkdir -p "$applications_dir"
  local desktop_file="${applications_dir}/serendesktop.desktop"

  cat <<EOF >"$desktop_file"
[Desktop Entry]
Type=Application
Name=Seren Local
Exec=${SEREN_BIN}/seren
Icon=${SEREN_ICON_PATH:-${SEREN_BIN}/seren}
Terminal=true
Categories=Utility;
EOF
  chmod +x "$desktop_file"

  if [ -d "${HOME}/Desktop" ]; then
    cp "$desktop_file" "${HOME}/Desktop/Seren Local.desktop"
  fi
  ok "Created desktop shortcut (Linux)"
}

create_macos_shortcut() {
  local app_dir="${HOME}/Applications/Seren Local.app"
  local desktop_alias="${HOME}/Desktop/Seren Local.app"
  mkdir -p "$app_dir/Contents/MacOS" "$app_dir/Contents/Resources"

  local icon_file="${app_dir}/Contents/Resources/seren.icns"
  if [ -n "$SEREN_ICON_PATH" ] && command -v sips >/dev/null 2>&1 && command -v iconutil >/dev/null 2>&1; then
    local temp_dir
    temp_dir=$(mktemp -d)
    local iconset="${temp_dir}/seren.iconset"
    mkdir -p "$iconset"
    for size in 16 32 64 128 256 512; do
      sips -z "$size" "$size" "$SEREN_ICON_PATH" --out "$iconset/icon_${size}x${size}.png" >/dev/null
      local doubled=$((size * 2))
      sips -z "$doubled" "$doubled" "$SEREN_ICON_PATH" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
    done
    if iconutil -c icns -o "$icon_file" "$iconset" >/dev/null 2>&1; then
      rm -rf "$temp_dir"
    else
      warn "Failed to convert icon; application will use default icon"
      rm -rf "$temp_dir"
      rm -f "$icon_file"
    fi
  fi

  cat <<EOF >"${app_dir}/Contents/Info.plist"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Seren Local</string>
  <key>CFBundleIdentifier</key>
  <string>com.seren.local</string>
  <key>CFBundleVersion</key>
  <string>1.0</string>
  <key>CFBundleExecutable</key>
  <string>SerenLocal</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleIconFile</key>
  <string>seren</string>
</dict>
</plist>
EOF

  cat >"${app_dir}/Contents/MacOS/SerenLocal" <<LAUNCHER
#!/bin/bash
export PATH="${SEREN_BIN}:${SEREN_NODE_DIR}/bin:\$PATH"
CMD="${SEREN_BIN}/serendesktop"
if [ ! -x "\$CMD" ]; then
  CMD="serendesktop"
fi
osascript <<OSA
tell application "Terminal"
  if not (exists window 1) then reopen
  do script "export PATH=${SEREN_BIN}:${SEREN_NODE_DIR}/bin:\\\$PATH && \$CMD" in front window
  activate
end tell
OSA
LAUNCHER
  chmod +x "${app_dir}/Contents/MacOS/SerenLocal"

  if [ -d "${HOME}/Desktop" ]; then
    ln -sfn "$app_dir" "$desktop_alias"
  fi
  ok "Created Seren Local app bundle"
}

create_desktop_shortcut() {
  case "$OS" in
    linux)
      create_linux_shortcut
      ;;
    darwin)
      create_macos_shortcut
      ;;
  esac
}

# ── Banner ─────────────────────────────────────────────────────────────
printf "\n"
info "╔══════════════════════════════════════════╗"
info "║    Seren Local Desktop Installer         ║"
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
      export PATH="${SEREN_NODE_DIR}/bin:${PATH}"
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
  local url="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${OS}-${ARCH}.tar.gz"
  local tmp_tar
  tmp_tar=$(mktemp "${TMPDIR:-/tmp}/seren-node-XXXXXX.tar.gz")

  start_spinner "Downloading Node.js v${NODE_VERSION} for ${OS}-${ARCH}..."

  # Download
  if command -v curl &>/dev/null; then
    curl -fsSL "$url" -o "$tmp_tar"
  elif command -v wget &>/dev/null; then
    wget -qO "$tmp_tar" "$url"
  else
    stop_spinner
    error "Neither curl nor wget found. Cannot download Node.js."
    exit 1
  fi

  stop_spinner

  start_spinner "Extracting Node.js..."

  # Extract to ~/.seren-local/node/
  mkdir -p "$SEREN_NODE_DIR"
  tar xzf "$tmp_tar" -C "$SEREN_NODE_DIR" --strip-components=1
  rm -f "$tmp_tar"

  stop_spinner

  NODE_BIN="${SEREN_NODE_DIR}/bin/node"
  NPM_BIN="${SEREN_NODE_DIR}/bin/npm"
  export PATH="${SEREN_NODE_DIR}/bin:${PATH}"

  local installed_version
  installed_version=$("$NODE_BIN" --version 2>/dev/null)
  ok "Installed Node.js ${installed_version} to ${SEREN_NODE_DIR}/"
}

# ── Check native build toolchain ──────────────────────────────────────
check_toolchain() {
  case "$OS" in
    darwin)
      if ! xcode-select -p &>/dev/null; then
        xcode-select --install 2>/dev/null || true
        info "A dialog should appear to install Xcode Command Line Tools."
        info "Please follow the prompts. This installer will wait up to 30 minutes."
        start_spinner "Waiting for Xcode Command Line Tools installation..."
        local xcode_waited=0
        local xcode_timeout=1800
        while ! xcode-select -p &>/dev/null; do
          sleep 5
          xcode_waited=$((xcode_waited + 5))
          if [ "$xcode_waited" -ge "$xcode_timeout" ]; then
            stop_spinner
            error "Timed out waiting for Xcode Command Line Tools."
            error "Please install manually: xcode-select --install"
            error "Then re-run this installer."
            exit 1
          fi
        done
        stop_spinner
        ok "Xcode Command Line Tools installed"
      else
        ok "Xcode Command Line Tools found"
      fi
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
  # Install into Seren's private prefix so no sudo is needed
  mkdir -p "$SEREN_BIN"

  local npm_log
  npm_log=$(mktemp "${TMPDIR:-/tmp}/seren-npm-XXXXXX.log")

  info "Installing ${PACKAGE} (this may take several minutes while compiling native modules)..."
  start_spinner "Installing ${PACKAGE}..." true
  if ! "$NPM_BIN" install -g "${PACKAGE}" --prefix "${SEREN_DIR}" >"$npm_log" 2>&1; then
    stop_spinner
    error "${PACKAGE} installation failed!"
    error "npm output:"
    cat "$npm_log" >&2
    rm -f "$npm_log"
    exit 1
  fi
  stop_spinner
  rm -f "$npm_log"
  ok "${PACKAGE} installed successfully!"

  # Install OpenClaw messaging gateway (optional, non-fatal)
  npm_log=$(mktemp "${TMPDIR:-/tmp}/seren-npm-XXXXXX.log")
  start_spinner "Installing openclaw..." true
  if "$NPM_BIN" install -g openclaw --ignore-scripts --prefix "${SEREN_DIR}" >"$npm_log" 2>&1; then
    stop_spinner
    ok "openclaw installed successfully!"
  else
    stop_spinner
    warn "openclaw install failed (messaging features will be unavailable)."
    warn "npm output:"
    cat "$npm_log" >&2
    warn "You can install it later: npm install -g openclaw"
  fi
  rm -f "$npm_log"
}

# ── Set up PATH ───────────────────────────────────────────────────────
setup_path() {
  # Include Seren's private Node in PATH so #!/usr/bin/env node works
  local path_line="export PATH=\"${SEREN_BIN}:${SEREN_NODE_DIR}/bin:\$PATH\""
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
    path_line="set -gx PATH ${SEREN_BIN} ${SEREN_NODE_DIR}/bin \$PATH"
  fi

  # Clean up stale openclaw completion line from previous installs
  if [ -f "$rc_file" ] && grep -q "openclaw completion" "$rc_file" 2>/dev/null; then
    sed -i.bak "/openclaw completion/d" "$rc_file" 2>/dev/null
    rm -f "${rc_file}.bak"
    ok "Removed stale openclaw completion line from ${rc_file}"
  fi

  # Add or update PATH in rc file
  if [ -f "$rc_file" ] && grep -qF "${SEREN_NODE_DIR}/bin" "$rc_file" 2>/dev/null; then
    ok "PATH already configured in ${rc_file}"
  else
    # Remove old Seren PATH line that may lack the node dir
    if [ -f "$rc_file" ]; then
      sed -i.bak "/${SEREN_BIN//\//\\/}/d" "$rc_file" 2>/dev/null
      rm -f "${rc_file}.bak"
    fi
    printf "\n# Seren Local Desktop\n%s\n" "$path_line" >> "$rc_file"
    ok "Added ${SEREN_BIN} and ${SEREN_NODE_DIR}/bin to PATH in ${rc_file}"
  fi

  # Also make it available in this session
  export PATH="${SEREN_BIN}:${SEREN_NODE_DIR}/bin:${PATH}"
}

# ── Verify installation ───────────────────────────────────────────────
verify_install() {
  if [ -x "${SEREN_BIN}/serendesktop" ] || command -v serendesktop &>/dev/null; then
    ok "serendesktop command is available"
  else
    # npm might place the bin in a different spot within the prefix
    local npm_bin_dir
    npm_bin_dir=$("$NPM_BIN" prefix -g 2>/dev/null)/bin
    if [ -x "${npm_bin_dir}/serendesktop" ]; then
      # Symlink into our bin dir
      ln -sf "${npm_bin_dir}/serendesktop" "${SEREN_BIN}/serendesktop"
      ok "serendesktop command is available"
    else
      warn "serendesktop command not found. You may need to restart your terminal."
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
  download_seren_icon
  create_desktop_shortcut

  printf "\n"
  info "╔══════════════════════════════════════════╗"
  info "║          Installation Complete!          ║"
  info "╚══════════════════════════════════════════╝"
  printf "\n"
  echo "  Start the runtime:"
  echo "    ${BOLD}serendesktop${RESET}"
  printf "\n"
  echo "  Then open Seren in your browser:"
  echo "    ${BOLD}https://app.seren-local.com${RESET}"
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
