#!/usr/bin/env bash
# ABOUTME: Uninstall script for Seren local runtime (macOS/Linux).
# ABOUTME: Removes the npm package and optionally the data directory.
#
# Usage: curl -fsSL https://serendb.com/uninstall | sh

set -euo pipefail

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
RESET='\033[0m'

PACKAGE="@serendb/runtime"
DATA_DIR="${HOME}/.seren-local"

info()  { printf "${BOLD}%s${RESET}\n" "$*"; }
ok()    { printf "${GREEN}✓ %s${RESET}\n" "$*"; }
warn()  { printf "${YELLOW}! %s${RESET}\n" "$*"; }

info "Uninstalling Seren Local Desktop..."
printf "\n"

# Remove npm package
if npm list -g "${PACKAGE}" &>/dev/null; then
  npm uninstall -g "${PACKAGE}"
  ok "Removed ${PACKAGE}"
else
  warn "${PACKAGE} was not installed globally"
fi

# Ask about data directory
if [ -d "$DATA_DIR" ]; then
  printf "\n"
  printf "Remove data directory ${DATA_DIR}? This deletes conversation history. [y/N] "
  read -r answer
  if [ "$answer" = "y" ] || [ "$answer" = "Y" ]; then
    rm -rf "$DATA_DIR"
    ok "Removed ${DATA_DIR}"
  else
    warn "Kept ${DATA_DIR}"
  fi
fi

printf "\n"
ok "Seren Local Desktop uninstalled."
printf "\n"
