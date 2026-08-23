#!/usr/bin/env bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
BOLD='\033[1m'
NC='\033[0m'

ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }
info() { echo -e "  ${CYAN}→${NC} $1"; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }

INSTALL_DIR=""
MODE="ui"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --cli) MODE="cli"; shift ;;
    --ui) MODE="ui"; shift ;;
    -h|--help)
      echo "Usage: bash install.sh [--dir /path] [--ui|--cli]"
      exit 0
      ;;
    *) fail "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ -z "$INSTALL_DIR" ]]; then
  INSTALL_DIR="$(pwd)/symbiote"
fi

REPO_URL="https://github.com/artifact-opensource/symbiote.git"
BRANCH="main"

echo ""
echo -e "${MAGENTA}╔══════════════════════════════════════════════╗${NC}"
echo -e "${MAGENTA}║${NC}  ${BOLD}Symbiote${NC} — Desktop Installer                ${MAGENTA}║${NC}"
echo -e "${MAGENTA}║${NC}  ${CYAN}Apex${NC} · production-ready setup             ${MAGENTA}║${NC}"
echo -e "${MAGENTA}╚══════════════════════════════════════════════╝${NC}"
echo ""

echo -e "${BOLD}[1/4] Checking prerequisites${NC}"
command -v node >/dev/null || { fail "Node.js 20+ is required"; exit 1; }
NODE_MAJOR="$(node -v | sed 's/v//' | cut -d. -f1)"
[[ "$NODE_MAJOR" -ge 20 ]] || { fail "Node.js 20+ is required (found $(node -v))"; exit 1; }
ok "Node.js $(node -v)"
command -v npm >/dev/null || { fail "npm is required"; exit 1; }
ok "npm $(npm -v)"
command -v git >/dev/null || { fail "git is required"; exit 1; }
ok "git $(git --version | awk '{print $3}')"

echo ""
echo -e "${BOLD}[2/4] Fetching source${NC}"
if [[ -d "$INSTALL_DIR/.git" ]]; then
  info "Updating existing install in $INSTALL_DIR"
  git -C "$INSTALL_DIR" fetch origin "$BRANCH"
  git -C "$INSTALL_DIR" checkout "$BRANCH"
  git -C "$INSTALL_DIR" pull --ff-only origin "$BRANCH"
else
  info "Cloning repository"
  git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi
ok "Source ready"

echo ""
echo -e "${BOLD}[3/4] Installing and building${NC}"
npm install --prefix "$INSTALL_DIR"
npm run build --prefix "$INSTALL_DIR"
ok "Build complete"

echo ""
echo -e "${BOLD}[4/4] Launching setup${NC}"
cd "$INSTALL_DIR"
if [[ "$MODE" == "ui" ]]; then
  info "Opening desktop installer UI in your browser"
  exec node dist/index.js init --ui
else
  info "Starting guided CLI setup"
  exec node dist/index.js install
fi
