#!/usr/bin/env bash
set -euo pipefail

# ----------------------------------------
# Configuration & Colors
# ----------------------------------------
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

BINARY_NAME="askai"
INSTALL_DIR="${ASKAI_INSTALL_DIR:-$HOME/.local/bin}"
CONFIG_DIR="${ASKAI_CONFIG_DIR:-$HOME/.askai}"
CONFIG_FILE="$CONFIG_DIR/settings.json"
DEFAULT_SETTINGS_FILE="settings.default.json"
CONFIG_MARKER="# askai shell integration"
REPO="hongyue/askai"
INSTALL_TMP="/tmp/askai_install_$(date +%s)"

# Helper Functions
log_info() { echo -e "${GREEN}✓${NC} $1"; }
log_warn() { echo -e "${YELLOW}⚠${NC} $1"; }
log_error() { echo -e "${RED}✗${NC} $1"; exit 1; }
have_cmd() { command -v "$1" >/dev/null 2>&1; }

# Cleanup trap
trap 'rm -rf "$INSTALL_TMP"' EXIT

# ----------------------------------------
# 1. ensure_bun (NEW & FIXED)
# ----------------------------------------
ensure_bun() {
    if have_cmd bun; then
        return
    fi

    echo -e "${YELLOW}Bun not found. Installing Bun...${NC}"
    
    if ! have_cmd curl; then
        log_error "curl is required to install Bun automatically."
    fi

    # Install Bun
    curl -fsSL https://bun.sh/install | bash

    # Add to PATH for this session (and potentially persist if in .profile)
    # We try the standard install location
    if [ -x "$HOME/.bun/bin/bun" ]; then
        export PATH="$HOME/.bun/bin:$PATH"
    elif [ -x "$HOME/.local/bin/bun" ]; then
        export PATH="$HOME/.local/bin:$PATH"
    else
        log_error "Bun installation failed (binary not found in expected paths)."
    fi

    if ! have_cmd bun; then
        log_error "Bun installation failed."
    fi
    
    log_info "Installed Bun"
}

# ----------------------------------------
# 2. Detect OS & Architecture
# ----------------------------------------
echo "🔍 Detecting system architecture..."

case "$(uname -s)" in
    Linux*)  OS="linux" ;;
    Darwin*) OS="darwin" ;;
    *) log_error "Unsupported OS: $(uname -s)";;
esac

case "$(uname -m)" in
    x86_64|amd64) ARCH="x64" ;;
    arm64|aarch64) ARCH="arm64" ;;
    *) log_error "Unsupported architecture: $(uname -m)";;
esac

TARGET_PATTERN="${OS}-${ARCH}"
echo "🎯 Target platform: $TARGET_PATTERN"

# ----------------------------------------
# 3. Ensure Unzip
# ----------------------------------------
if ! have_cmd unzip; then
    echo "📦 Checking for unzip..."
    SUDO_CMD=""
    if [[ "$(id -u)" -eq 0 ]]; then
        SUDO_CMD=""
    elif have_cmd sudo; then
        SUDO_CMD="sudo"
    else
        log_warn "Unzip missing. Install manually and re-run."
        exit 0
    fi

    if have_cmd apt-get; then
        $SUDO_CMD apt-get update -qq && $SUDO_CMD apt-get install -y unzip -qq
    elif have_cmd yum; then
        $SUDO_CMD yum install -y unzip
    elif have_cmd dnf; then
        $SUDO_CMD dnf install -y unzip
    elif have_cmd apk; then
        $SUDO_CMD apk add unzip
    else
        log_warn "Package manager not found for unzip."
        exit 0
    fi

    if ! have_cmd unzip; then
        log_warn "Unzip installation failed."
        exit 0
    fi
fi

# ----------------------------------------
# 4. Prepare Workspace
# ----------------------------------------
mkdir -p "$INSTALL_TMP"

# ----------------------------------------
# 5. Mode Detection
# ----------------------------------------
IS_SOURCE_MODE=false
if [ -f "package.json" ] && [ -f "bun.lock" ]; then
    IS_SOURCE_MODE=true
    echo "📦 Mode: SOURCE"
else
    cd "$INSTALL_TMP"
    echo "📦 Mode: BINARY"
fi

WORK_DIR="$INSTALL_TMP/askai-work"
mkdir -p "$WORK_DIR"

# ----------------------------------------
# 6. Execution Logic
# ----------------------------------------

if [ "$IS_SOURCE_MODE" = true ]; then
    cp -r . "$WORK_DIR"
    cd "$WORK_DIR"

    # Check if binary already built
    if [ -x "$PWD/$BINARY_NAME" ]; then
        log_info "Binary already built locally. Skipping build."
    else
        echo "🔨 Building from source..."
        ensure_bun
        (bun install --frozen-lockfile && bun run build)
    fi
else
    # 5a. Check if binary exists locally
    if [ -x "$PWD/$BINARY_NAME" ]; then
        log_info "Binary found locally. Skipping download and build."
        cp "$PWD/$BINARY_NAME" "$WORK_DIR/$BINARY_NAME"
        if [ -f "$PWD/$DEFAULT_SETTINGS_FILE" ]; then
            cp "$PWD/$DEFAULT_SETTINGS_FILE" "$WORK_DIR/$DEFAULT_SETTINGS_FILE"
        fi
    else
        # 5b. Binary missing -> Download from GitHub
        echo "📥 Binary not found locally. Fetching from GitHub..."
        
        RELEASE_JSON=$(curl -s "https://api.github.com/repos/$REPO/releases/latest")
        DOWNLOAD_URL=""
        
        if echo "$RELEASE_JSON" | grep -q '"Not Found"'; then
            log_warn "No Release Found. Falling back to source tarball."
            DOWNLOAD_URL=""
        else
            if have_cmd jq; then
                DOWNLOAD_URL=$(echo "$RELEASE_JSON" | jq -r ".assets[] | select(.browser_download_url | test(\"$TARGET_PATTERN\")) | .browser_download_url" | head -n 1)
            else
                DOWNLOAD_URL=$(echo "$RELEASE_JSON" | grep -oE "https://[^\"]*${TARGET_PATTERN}[^\"]*" | head -n 1)
            fi
        fi

        if [[ -n "${DOWNLOAD_URL:-}" ]]; then
            FILE_NAME=$(basename "$DOWNLOAD_URL")
            curl -L -o "$WORK_DIR/$FILE_NAME" "$DOWNLOAD_URL"

            case "$FILE_NAME" in
                *.tar.gz|*.tgz)
                    tar -xzf "$WORK_DIR/$FILE_NAME" -C "$WORK_DIR"
                    ;;
                *.zip)
                    unzip -q "$WORK_DIR/$FILE_NAME" -d "$WORK_DIR"
                    ;;
                *) log_error "Unknown archive: $FILE_NAME";;
            esac
        else
            # Fallback: Download source code
            echo "⚠️ No pre-built binary found. Downloading source..."
            if have_cmd jq; then
                BRANCH=$(curl -s "https://api.github.com/repos/$REPO" | jq -r '.default_branch')
            else
                BRANCH="main"
            fi
            curl -L -o source.tar.gz "https://github.com/$REPO/archive/refs/heads/$BRANCH.tar.gz"
            tar -xzf source.tar.gz -C "$WORK_DIR"
            cd "$WORK_DIR/askai-${BRANCH}"
            
            ensure_bun
            (bun install --frozen-lockfile && bun run build)

            cp "$BINARY_NAME" "$WORK_DIR/$BINARY_NAME" 2>/dev/null
            cp "$DEFAULT_SETTINGS_FILE" "$WORK_DIR/$DEFAULT_SETTINGS_FILE" 2>/dev/null
        fi
    fi
fi

# ----------------------------------------
# 7. Finalize Installation
# ----------------------------------------
if [ ! -x "$WORK_DIR/$BINARY_NAME" ]; then
    log_error "Installation failed."
fi

# Copy binary
mkdir -p "$INSTALL_DIR"
cp "$WORK_DIR/$BINARY_NAME" "$INSTALL_DIR/$BINARY_NAME"
chmod +x "$INSTALL_DIR/$BINARY_NAME"
log_info "Installed binary to $INSTALL_DIR"

# Install Default Settings
mkdir -p "$CONFIG_DIR"
if [ ! -f "$CONFIG_FILE" ]; then
    if [ -f "$WORK_DIR/$DEFAULT_SETTINGS_FILE" ]; then
        cp "$WORK_DIR/$DEFAULT_SETTINGS_FILE" "$CONFIG_FILE"
        log_info "Installed default settings to $CONFIG_FILE"
    elif [ -f "$WORK_DIR/settings.json" ]; then
        cp "$WORK_DIR/settings.json" "$CONFIG_FILE"
        log_info "Installed default settings to $CONFIG_FILE"
    else
        log_warn "Default settings file missing. Created empty config."
        echo "{}" > "$CONFIG_FILE"
    fi
else
    log_warn "Existing settings preserved at $CONFIG_FILE"
fi

# PATH & Shell Integration Helpers
detect_shell() { basename "${SHELL:-sh}"; }

ensure_path() {
    if [[ ":$PATH:" == *":$INSTALL_DIR:"* ]]; then return; fi
    shell=$(detect_shell)
    config_file=""
    path_export="export PATH=\"$INSTALL_DIR:\$PATH\""

    case "$shell" in
        zsh) config_file="$HOME/.zshrc" ;;
        bash) config_file="$HOME/.bashrc" ;;
        fish)
            config_file="$HOME/.config/fish/config.fish"
            path_export="fish_add_path $INSTALL_DIR"
            ;;
        *) log_warn "Shell not recognized ($shell)."; return ;;
    esac

    if [[ -n "$config_file" ]]; then
        if [[ ! -f "$config_file" ]] || ! grep -q "$INSTALL_DIR" "$config_file" 2>/dev/null; then
            mkdir -p "$(dirname "$config_file")"
            echo "" >> "$config_file"
            echo "# Add ~/.local/bin to PATH" >> "$config_file"
            echo "$path_export" >> "$config_file"
            log_info "Updated $config_file"
        fi
    fi
}
ensure_path

add_shell_integration() {
    shell=$(detect_shell)
    config_file=""
    alias_code=""

    case "$shell" in
        zsh)
            config_file="$HOME/.zshrc"
            alias_code="alias askai='noglob askai'"
            ;;
        bash)
            config_file="$HOME/.bashrc"
            alias_code='askai() {
  local args=() question="" in_question=false
  for arg in "$@"; do
    if [[ "$arg" == -* ]] && ! $in_question; then
      args+=("$arg")
    else
      in_question=true
      question+="${question:+ }$arg"
    fi
  done
  if [[ -n "$question" ]]; then
    command askai "${args[@]}" "$question"
  else
    command askai "$@"
  fi
}'
            ;;
        fish)
            config_file="$HOME/.config/fish/config.fish"
            alias_code="function askai; noglob command askai \$argv; end"
            ;;
        *) return ;;
    esac

    if [[ -f "$config_file" ]] && grep -q "$CONFIG_MARKER" "$config_file" 2>/dev/null; then
        log_warn "Shell integration already exists in $config_file"
        return
    fi

    mkdir -p "$(dirname "$config_file")"
    echo "" >> "$config_file"
    echo "$CONFIG_MARKER" >> "$config_file"
    echo "$alias_code" >> "$config_file"
    log_info "Added shell integration to $config_file"
}
add_shell_integration

# ----------------------------------------
# 8. Done
# ----------------------------------------
echo ""
echo -e "${GREEN}🎉 Installation Complete!${NC}"
echo "Binary: $INSTALL_DIR/$BINARY_NAME"
echo "Config: $CONFIG_FILE"
echo "Run 'askai' to start."
echo "Restart terminal or run 'source $HOME/.bashrc' (or .zshrc) to apply PATH."
