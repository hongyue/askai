# askai

A terminal AI agent that answers your questions with streaming responses and shell command execution.

## Features

- **Multiple Providers**: OpenAI, OpenRouter, Anthropic (Claude), Ollama, llama.cpp (OpenAI-compatible)
- **MCP Support**: Connect to MCP servers for extended tools
- **Terminal UI**: Interactive TUI with command palette and oneshot queries
- **Streaming**: Real-time response streaming
- **Shell Execution**: Detect and execute bash commands with user approval
- **Single Binary**: Compiled with Bun for easy distribution

## Installation

### Quick Install (Recommended)

```bash
# Build the binary
bun install
bun run build

# Run installer
./install.sh
```

The installer will:
1. Copy the binary to `~/.local/bin/`
2. Add `~/.local/bin` to your PATH if needed
3. Add shell integration (alias for special characters)

### Manual Install

1. Build: `bun install && bun run build`
2. Copy binary: `cp askai ~/.local/bin/`
3. Add shell integration (see below)

### Shell Integration

The installer automatically adds shell integration. To add manually:

**zsh** (`~/.zshrc`):
```bash
alias askai='noglob askai'
```

**bash** (`~/.bashrc`):
```bash
askai() {
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
}
```

**fish** (`~/.config/fish/config.fish`):
```bash
function askai; noglob command askai $argv; end
```

**Without shell integration**: Quote questions containing special characters (`? * [ ] { }`):
```bash
askai "what is 2+2?"
```

## Configuration

Create a settings file at `~/.askai/settings.json`:

```bash
askai --init
```

Or manually create it:

```json
{
  "provider": "llama.cpp",
  "providers": {
    "llama.cpp": {
      "api_key": "optional",
      "model": "your-model-name",
      "base_url": "http://localhost:8080/v1"
    },
    "openai": {
      "api_key": "sk-your-key",
      "model": "gpt-4o",
      "base_url": "https://api.openai.com/v1"
    },
    "openrouter": {
      "api_key": "sk-or-your-key",
      "model": "openai/gpt-4o-mini",
      "base_url": "https://openrouter.ai/api/v1"
    },
    "anthropic": {
      "api_key": "sk-ant-your-key",
      "model": "claude-sonnet-4-20250514"
    }
  },
  "allowExecute": true,
  "mcp": {
    "autoExecute": false
  },
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/dir"],
      "autoExecute": true
    }
  }
}
```

## Usage

### Oneshot Mode

```bash
askai what is the capital of France
```

### Interactive Mode

```bash
askai
```

### Options

```bash
askai [options] [question...]

Options:
  -p, --provider <name>  Override provider
  -m, --model <name>     Override model
  -c, --config <path>    Config file path
  -e, --execute <mode>   Set shell command execution: on or off
  -x, --mcp <mode>       Enable / disable MCP servers: on or off
  -i, --init             Create default config file
```

### Examples

```bash
# Use OpenAI provider
askai -p openai explain quantum computing

# Use OpenRouter provider
askai -p openrouter explain quantum computing

# Use llama.cpp-compatible server
askai -p llama.cpp local coding help

# Use specific model
askai -m gpt-4o-mini quick question

# Disable command execution
askai --execute off how do I list files

# Enable command execution
askai --execute on how do I list files

# Disable global MCP usage
askai --mcp off what is 2+2

# Enable global MCP usage
askai --mcp on what is 2+2

# Use custom config
askai -c ./my-settings.json hello
```

## Shell Command Execution

When the AI suggests a bash command, it will be displayed in a formatted box and you'll be prompted:

```
┌────────────────────────────────────────────────────────────┐
  │ ls -la
└────────────────────────────────────────────────────────────┘
? Execute this command? (y/N)
```

Type `y` to execute or `n` to skip.

Set the default in config with:

```json
{
  "allowExecute": true
}
```

## MCP Support

askai supports the Model Context Protocol (MCP) for extended tool capabilities.

### Supported Transports

- **stdio**: Run MCP servers as subprocesses
- **Streamable HTTP**: Connect to remote MCP servers

### Tool Execution

Tools can be configured to:
- **Auto-execute**: Run without confirmation
- **User approval**: Prompt before execution

```json
{
  "mcp": {
    "autoExecute": false
  },
  "mcpServers": {
    "server-name": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-name"],
      "autoExecute": true
    }
  }
}
```

## Development

```bash
# Install dependencies
bun install

# Run in development mode
bun run dev

# Build binary
bun run build

# Run installer
./install.sh
```

## License

MIT
