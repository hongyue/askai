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
├── index.ts              # Entry (has shebang, DO NOT remove)
├── cli.ts                # Commander.js CLI, defines all options
├── app.ts                # TUIApp class (main interactive UI)
├── oneshot.ts            # One-shot mode (non-interactive CLI)
├── app-runtime.ts        # Runtime initialization, provider management
├── input-utils.ts        # Keyboard matchers (Ctrl+U/A/E, arrows, etc.), formatters
├── commands.ts           # Slash commands (/help, /exit)
├── config.ts             # Config loading (supports defaults from settings.default.json)
├── shell.ts              # Shell command detection/execution
├── session.ts            # Chat session management
├── version.ts            # appVersion export
├── ui/
│   ├── tui-types.ts      # Shared MutableNode interfaces
│   ├── palette.ts        # Command palette rendering/management
│   ├── modals.ts         # Modal rendering (provider, model, sessions)
│   ├── modals-state.ts   # Provider/model form state + operations
│   ├── modal-keyboard.ts # Modal keyboard handlers (Ctrl+U/A/E, paste, etc.)
│   ├── chat.ts           # Chat loop, messaging, tool calls
│   ├── approval.ts       # Approval dialog + shell execution
│   └── mcp.ts            # MCP modal + connection management
├── providers/            # OpenAI, Anthropic, custom (ollama/sglang/vllm)
└── mcp/                  # MCP server manager, client, tool conversion
```

## Architecture

### TUIApp Class (`app.ts`)
- `TUIApp` class uses `static async create()` factory pattern (constructor is private)
- Composed via sub-managers: `PaletteManager`, `McpManager`, `ApprovalManager`, `ChatManager`, `ModalsStateManager`
- Each manager takes a minimal host interface (not the full TUIApp) for encapsulation

### Modal Input Handling
- All modal inputs use manual `prependInputHandler` dispatching (not OpenTUI focus system)
- Keyboard shortcuts: Ctrl+U (kill line), Ctrl+A (move to start), Ctrl+E (move to end), paste support
- Modal z-order: model modal > provider modal (model checked first in key dispatch)
- Opening model modal no longer closes provider modal; closing model modal returns focus correctly

## Key Notes

- `src/index.ts` shebang (`#!/usr/bin/env bun`) is required for binary execution - do not remove
- Two modes: oneshot (`src/oneshot.ts`) vs OpenTUI (`src/app.ts`)
- Provider factory in `providers/index.ts` uses `kind` field to instantiate correct provider class
- MCP uses `@modelcontextprotocol/sdk` with stdio and Streamable HTTP transports
- Input utilities in `input-utils.ts` support both traditional terminal and Kitty keyboard protocol
