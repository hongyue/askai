#!/bin/bash
set -euo pipefail

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
ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"

detect_shell() {
  basename "${SHELL:-sh}"
}

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

ensure_bun() {
  if have_cmd bun; then
    return
  fi

  echo -e "${YELLOW}Bun not found. Installing Bun...${NC}"
  if ! have_cmd curl; then
    echo -e "${RED}✗${NC} curl is required to install Bun automatically."
    exit 1
  fi

  curl -fsSL https://bun.sh/install | bash

  if [ -x "$HOME/.bun/bin/bun" ]; then
    export PATH="$HOME/.bun/bin:$PATH"
  fi

  if ! have_cmd bun; then
    echo -e "${RED}✗${NC} Bun installation failed."
    exit 1
  fi

  echo -e "${GREEN}✓${NC} Installed Bun"
}

build_binary_from_source() {
  echo -e "${YELLOW}Building askai from source...${NC}"
  ensure_bun
  (cd "$ROOT_DIR" && bun install --frozen-lockfile && bun run build)
}

ensure_binary() {
  if [ -x "$ROOT_DIR/$BINARY_NAME" ]; then
    return
  fi

  build_binary_from_source

  if [ ! -x "$ROOT_DIR/$BINARY_NAME" ]; then
    echo -e "${RED}✗${NC} Failed to produce $BINARY_NAME"
    exit 1
  fi
}

install_binary() {
  mkdir -p "$INSTALL_DIR"
  cp "$ROOT_DIR/$BINARY_NAME" "$INSTALL_DIR/$BINARY_NAME"
  chmod +x "$INSTALL_DIR/$BINARY_NAME"
  echo -e "${GREEN}✓${NC} Installed $BINARY_NAME to $INSTALL_DIR"
}

install_default_settings() {
  mkdir -p "$CONFIG_DIR"

  if [ -f "$CONFIG_FILE" ]; then
    echo -e "${YELLOW}⚠${NC} Existing settings preserved at $CONFIG_FILE"
    return
  fi

  if [ ! -f "$ROOT_DIR/$DEFAULT_SETTINGS_FILE" ]; then
    echo -e "${RED}✗${NC} Bundled $DEFAULT_SETTINGS_FILE not found"
    exit 1
  fi

  cp "$ROOT_DIR/$DEFAULT_SETTINGS_FILE" "$CONFIG_FILE"
  echo -e "${GREEN}✓${NC} Installed default settings to $CONFIG_FILE"
}

ensure_path() {
  if [[ ":$PATH:" == *":$INSTALL_DIR:"* ]]; then
    return
  fi

  local shell config_file path_export
  shell=$(detect_shell)
  config_file=""
  path_export="export PATH=\"$INSTALL_DIR:\$PATH\""

  case "$shell" in
    zsh)  config_file="$HOME/.zshrc" ;;
    bash) config_file="$HOME/.bashrc" ;;
    fish)
      config_file="$HOME/.config/fish/config.fish"
      path_export="fish_add_path $INSTALL_DIR"
      ;;
  esac

  if [[ -n "$config_file" ]]; then
    if [[ ! -f "$config_file" ]] || ! grep -q "$INSTALL_DIR" "$config_file" 2>/dev/null; then
      mkdir -p "$(dirname "$config_file")"
      echo "" >> "$config_file"
      echo "# Add ~/.local/bin to PATH" >> "$config_file"
      echo "$path_export" >> "$config_file"
      echo -e "${GREEN}✓${NC} Added $INSTALL_DIR to PATH in $config_file"
    fi
  fi
}

add_shell_integration() {
  local shell config_file alias_code
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
    *)
      echo -e "${YELLOW}⚠${NC} Unknown shell ($(detect_shell)). Please add shell integration manually."
      return
      ;;
  esac

  if [[ -f "$config_file" ]] && grep -q "$CONFIG_MARKER" "$config_file" 2>/dev/null; then
    echo -e "${YELLOW}⚠${NC} Shell integration already exists in $config_file"
    return
  fi

  mkdir -p "$(dirname "$config_file")"
  echo "" >> "$config_file"
  echo "$CONFIG_MARKER" >> "$config_file"
  echo "$alias_code" >> "$config_file"
  echo -e "${GREEN}✓${NC} Added shell integration to $config_file"
}

main() {
  echo -e "${GREEN}Installing askai...${NC}"
  echo ""

  ensure_binary
  install_binary
  install_default_settings
  ensure_path
  add_shell_integration

  echo ""
  echo -e "${GREEN}✓ Installation complete!${NC}"
  echo ""
  echo "Installed binary:"
  echo "  $INSTALL_DIR/$BINARY_NAME"
  echo ""
  echo "Installed settings:"
  echo "  $CONFIG_FILE"
  echo ""
  echo "Review the settings file and update provider credentials before first real use."
  echo ""
  echo "To activate shell integration, restart your terminal or source your shell config."
}

main "$@"
