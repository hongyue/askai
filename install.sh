#!/bin/bash
set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# Config
BINARY_NAME="askai"
INSTALL_DIR="$HOME/.local/bin"
CONFIG_MARKER="# askai shell integration"

# Detect OS
detect_os() {
  case "$(uname -s)" in
    Darwin*) echo "macos";;
    Linux*)  echo "linux";;
    *)       echo "unknown";;
  esac
}

# Detect shell
detect_shell() {
  local shell_name=$(basename "$SHELL")
  echo "$shell_name"
}

# Install binary
install_binary() {
  mkdir -p "$INSTALL_DIR"
  cp "./$BINARY_NAME" "$INSTALL_DIR/$BINARY_NAME"
  chmod +x "$INSTALL_DIR/$BINARY_NAME"
  echo -e "${GREEN}✓${NC} Installed $BINARY_NAME to $INSTALL_DIR"
}

# Add to PATH if needed
ensure_path() {
  if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
    local shell=$(detect_shell)
    local config_file=""
    local path_export="export PATH=\"\$HOME/.local/bin:\$PATH\""
    
    case $shell in
      zsh)  config_file="$HOME/.zshrc";;
      bash) config_file="$HOME/.bashrc";;
      fish) config_file="$HOME/.config/fish/config.fish"
            path_export="fish_add_path \$HOME/.local/bin";;
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
  fi
}

# Add shell integration
add_shell_integration() {
  local shell=$(detect_shell)
  local config_file=""
  local alias_code=""
  
  case $shell in
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
      echo -e "${YELLOW}⚠${NC} Unknown shell ($shell). Please add alias manually."
      return
      ;;
  esac
  
  # Check if integration already exists
  if [[ -f "$config_file" ]] && grep -q "$CONFIG_MARKER" "$config_file" 2>/dev/null; then
    echo -e "${YELLOW}⚠${NC} Shell integration already exists in $config_file"
    return
  fi
  
  # Add integration
  mkdir -p "$(dirname "$config_file")"
  echo "" >> "$config_file"
  echo "$CONFIG_MARKER" >> "$config_file"
  echo "$alias_code" >> "$config_file"
  echo -e "${GREEN}✓${NC} Added shell integration to $config_file"
}

# Main
main() {
  echo -e "${GREEN}Installing askai...${NC}"
  echo ""
  
  # Check binary exists
  if [[ ! -f "./$BINARY_NAME" ]]; then
    echo -e "${RED}✗${NC} Binary ./$BINARY_NAME not found"
    echo "Please run this script from the directory containing the askai binary"
    exit 1
  fi
  
  # Detect environment
  local os=$(detect_os)
  local shell=$(detect_shell)
  
  echo -e "Detected: ${YELLOW}$os${NC} with ${YELLOW}$shell${NC}"
  echo ""
  
  # Install
  install_binary
  ensure_path
  add_shell_integration
  
  echo ""
  echo -e "${GREEN}✓ Installation complete!${NC}"
  echo ""
  echo "To activate shell integration, run:"
  
  case $shell in
    zsh)  echo "  source ~/.zshrc";;
    bash) echo "  source ~/.bashrc";;
    fish) echo "  source ~/.config/fish/config.fish";;
  esac
  
  echo ""
  echo "Or restart your terminal."
  echo ""
  echo "Usage:"
  echo "  askai what is 2+2"
  echo "  askai --help"
}

main "$@"
