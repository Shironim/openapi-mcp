#!/bin/sh
set -e

# ==============================================================================
# openapi-mcp Standalone Binary Installer (Linux & macOS)
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Shironim/openapi-mcp/master/scripts/install.sh | sh
#
# Environment variables:
#   OPENAPI_MCP_VERSION     Specific version tag to install (default: latest release)
#   OPENAPI_MCP_INSTALL_DIR Target directory for binary (default: /usr/local/bin if writable, else ~/.local/bin)
#   OPENAPI_MCP_REPO        GitHub repository slug (default: Shironim/openapi-mcp)
# ==============================================================================

REPO="${OPENAPI_MCP_REPO:-Shironim/openapi-mcp}"
BINARY_NAME="openapi-mcp"

if [ -t 1 ]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  CYAN='\033[0;36m'
  YELLOW='\033[0;33m'
  BOLD='\033[1m'
  NC='\033[0m'
else
  RED=''
  GREEN=''
  CYAN=''
  YELLOW=''
  BOLD=''
  NC=''
fi

info() {
  printf "${CYAN}[info]${NC} %s\n" "$1"
}

success() {
  printf "${GREEN}[success]${NC} ${BOLD}%s${NC}\n" "$1"
}

warn() {
  printf "${YELLOW}[warn]${NC} %s\n" "$1"
}

error() {
  printf "${RED}[error]${NC} %s\n" "$1" >&2
  exit 1
}

# 1. Detect OS
OS_RAW=$(uname -s)
case "${OS_RAW}" in
  Linux*)  OS="linux" ;;
  Darwin*) OS="darwin" ;;
  MINGW*|MSYS*|CYGWIN*)
    error "Windows shell detected. Please use PowerShell installer: irm https://raw.githubusercontent.com/${REPO}/master/scripts/install.ps1 | iex"
    ;;
  *)
    error "Unsupported operating system: ${OS_RAW}"
    ;;
esac

# 2. Detect Architecture
ARCH_RAW=$(uname -m)
case "${ARCH_RAW}" in
  x86_64|amd64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *)
    error "Unsupported architecture: ${ARCH_RAW}. Prebuilt binaries are provided for x64 and arm64."
    ;;
esac

TARGET="${BINARY_NAME}-${OS}-${ARCH}"
info "Detected platform: ${OS}-${ARCH} (target: ${TARGET})"

# 3. Determine download URL
VERSION_INPUT="${OPENAPI_MCP_VERSION:-${VERSION:-}}"
if [ -n "${VERSION_INPUT}" ]; then
  BASE_URL="https://github.com/${REPO}/releases/download/${VERSION_INPUT}"
  info "Installing specified version: ${VERSION_INPUT}"
else
  BASE_URL="https://github.com/${REPO}/releases/latest/download"
  info "Fetching latest release from ${REPO}..."
fi

DOWNLOAD_URL="${BASE_URL}/${TARGET}"
CHECKSUM_URL="${BASE_URL}/checksums.txt"

# 4. Determine installation directory
if [ -n "${OPENAPI_MCP_INSTALL_DIR:-}" ]; then
  INSTALL_DIR="${OPENAPI_MCP_INSTALL_DIR}"
elif [ -w "/usr/local/bin" ] || [ "$(id -u)" -eq 0 ]; then
  INSTALL_DIR="/usr/local/bin"
else
  INSTALL_DIR="${HOME}/.local/bin"
fi

mkdir -p "${INSTALL_DIR}" 2>/dev/null || {
  error "Failed to create installation directory: ${INSTALL_DIR}"
}

TMP_DIR=$(mktemp -d 2>/dev/null || mktemp -d -t 'openapi-mcp-install')
cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT INT TERM

download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    error "Install curl or wget to download release assets."
  fi
}

info "Downloading ${TARGET}..."
TMP_BIN="${TMP_DIR}/${BINARY_NAME}"
TMP_CHECKSUMS="${TMP_DIR}/checksums.txt"
download "${DOWNLOAD_URL}" "${TMP_BIN}" || error "Failed to download binary from: ${DOWNLOAD_URL}"
download "${CHECKSUM_URL}" "${TMP_CHECKSUMS}" || error "Failed to download checksums from: ${CHECKSUM_URL}"

EXPECTED_SHA=$(awk -v target="${TARGET}" '$2 == target { print $1 }' "${TMP_CHECKSUMS}")
case "$EXPECTED_SHA" in
  *[!0-9a-f]*|'') error "Missing or invalid SHA-256 checksum for ${TARGET}." ;;
esac
[ "${#EXPECTED_SHA}" -eq 64 ] || error "Invalid SHA-256 checksum for ${TARGET}."
if command -v sha256sum >/dev/null 2>&1; then
  RESULT=$(sha256sum "${TMP_BIN}") || error "sha256sum failed."
elif command -v shasum >/dev/null 2>&1; then
  RESULT=$(shasum -a 256 "${TMP_BIN}") || error "shasum failed."
else
  error "Install sha256sum or shasum to verify release assets."
fi
ACTUAL_SHA=${RESULT%% *}
[ "${EXPECTED_SHA}" = "${ACTUAL_SHA}" ] || error "Checksum verification failed for ${TARGET}."
info "Checksum verified: ${ACTUAL_SHA}"

chmod +x "${TMP_BIN}"
INSTALLED_VER=$("${TMP_BIN}" --version 2>&1) || error "Downloaded binary could not run on this system."

# 7. Move binary into place
TARGET_BIN="${INSTALL_DIR}/${BINARY_NAME}"
if [ -w "${INSTALL_DIR}" ]; then
  mv -f "${TMP_BIN}" "${TARGET_BIN}"
else
  info "Escalating privileges with sudo to install into ${INSTALL_DIR}..."
  sudo mv -f "${TMP_BIN}" "${TARGET_BIN}"
  sudo chmod +x "${TARGET_BIN}"
fi

# 8. Check PATH availability
PATH_WARNING=""
case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *) PATH_WARNING=1 ;;
esac

printf "\n"
success "openapi-mcp installed at: ${TARGET_BIN}"
if [ -n "${INSTALLED_VER}" ]; then
  printf "       version: %s\n" "${INSTALLED_VER}"
fi

if [ -n "${PATH_WARNING}" ]; then
  warn "Directory '${INSTALL_DIR}' is not in your PATH."
  printf "\nAdd this line to your shell profile (~/.bashrc, ~/.zshrc, or ~/.profile):\n\n"
  printf "  ${BOLD}export PATH=\"%s:\$PATH\"${NC}\n\n" "${INSTALL_DIR}"
fi

printf "\n${BOLD}Quick Start:${NC}\n"
printf "  1. Run ${CYAN}openapi-mcp --help${RESET:-${NC}} to inspect CLI options.\n"
printf "  2. Configure MCP client command: ${CYAN}openapi-mcp serve${NC}\n\n"
