# askai

A terminal AI agent that answers your questions with streaming responses and shell command execution.

## Installation

### Install

```bash
curl -fsSL https://github.com/hongyue/askai/raw/refs/heads/main/install.sh | bash
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

### Multiline Input

Use `Shift+Enter` to insert a new line in the prompt editor. If it doesn't work use 
`Shift+J` as a fallback.

If you use `tmux`, enable extended keys so `Shift+Enter` is passed through to askai:

```tmux
set -s extended-keys on
set -as terminal-features 'xterm*:extkeys'
set -g extended-keys-format csi-u
```

Then restart tmux completely:

```bash
tmux kill-server
tmux
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
