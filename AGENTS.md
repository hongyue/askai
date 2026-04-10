# AGENTS.md - askai

## Build/Release

```bash
bun install          # Install deps
bun run dev          # Watch mode (src/index.ts with shebang #!/usr/bin/env bun)
bun run typecheck    # npx tsc --noEmit (no lint/test scripts configured)
bun run build        # Runs typecheck then bun build --compile
./askai              # Built binary
```

Release: tag `v*` triggers GitHub Actions (`.github/workflows/release.yml`) which builds for linux-x64, linux-arm64, darwin-x64, darwin-arm64.

## CLI

```bash
askai [question...]           # Oneshot mode
askai                          # Interactive mode
-p <id> -m <model> -c <path>   # Provider/model/config override
-e on|off                      # Shell command auto-execute
--no-mcp                       # Disable MCP
```

## Configuration

`~/.askai/settings.json` or `-c <path>`. Provider `kind`: `"openai"` | `"anthropic"` | `"openrouter"` | `"custom"`.

```json
{
  "provider": "Ollama",
  "allowExecute": true,
  "providers": {
    "OpenAI": { "kind": "openai", "api_key": "...", "base_url": "...", "model": "gpt-4o" },
    "Anthropic": { "kind": "anthropic", "api_key": "...", "model": "claude-sonnet-4-20250514" },
    "Ollama": { "kind": "custom", "api_key": "ollama", "base_url": "http://localhost:11434/v1", "model": "llama3" }
  },
  "mcpServers": {}
}
```

## Project Structure

```
src/
├── index.ts          # Entry (has shebang, DO NOT remove)
├── cli.ts            # Commander.js CLI, defines all options
├── app.ts            # Main UI (oneshot vs interactive)
├── commands.ts       # Slash commands (/help, /exit)
├── config.ts         # Config loading (supports defaults from settings.default.json)
├── shell.ts          # Shell command detection/execution
├── session.ts        # Chat session management
├── version.ts        # appVersion export
├── providers/        # OpenAI, Anthropic, custom (ollama/sglang/vllm)
└── mcp/              # MCP server manager, client, tool conversion
```

## Key Notes

- `src/index.ts` shebang (`#!/usr/bin/env bun`) is required for binary execution - do not remove
- Two modes: oneshot (args passed) vs OpenTUI (no args, interactive)
- Provider factory in `providers/index.ts` uses `kind` field to instantiate correct provider class
- MCP uses `@modelcontextprotocol/sdk` with stdio and Streamable HTTP transports
