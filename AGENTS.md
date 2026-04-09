# AGENTS.md - askai

## Project Overview

A terminal AI agent supporting multiple providers (OpenAI, Anthropic, Ollama, llama.cpp), MCP tool integration, and shell command execution. Built with TypeScript and Bun.

## Build/Run Commands

```bash
# Install dependencies
bun install

# Development (watch mode)
bun run dev

# Build single binary
bun run build

# Run directly
bun run start

# Run built binary
./askai [question...]
```

**Note:** No lint or test scripts are configured. Use `npx tsc --noEmit` for type checking.

## Project Structure

```
src/
├── index.ts          # Entry point, CLI argument parsing
├── cli.ts            # Commander.js CLI setup
├── app.ts            # Main terminal UI
├── commands.ts       # Slash commands (/help, /exit, etc.)
├── config.ts         # Config loading/saving
├── shell.ts          # Shell command detection/execution
├── providers/
│   ├── base.ts       # Provider interface
│   ├── index.ts      # Provider exports and factory
│   ├── openai.ts     # OpenAI provider
│   └── anthropic.ts  # Anthropic provider
└── mcp/
    ├── index.ts      # MCP server manager
    ├── client.ts     # MCP client wrapper
    └── tools.ts      # Tool conversion utilities
```

## Code Style

### Imports
- Use relative imports for local modules: `import { foo } from './bar'`
- External packages imported normally: `import { Command } from 'commander'`
- Type imports use `import type` when only needed for types

### Types
- Define interfaces for config, options, and data structures
- Use `interface` over `type` for object shapes
- Use union types for limited options: `'system' | 'user' | 'assistant'`
- Avoid `any` when possible; use generics or specific types

### Naming
- Functions: camelCase (`loadConfig`, `createProvider`)
- Classes: PascalCase (`MCPManager`, `OpenAIProvider`)
- Interfaces: PascalCase (`ProviderConfig`, `Message`)
- Constants: camelCase or UPPER_CASE for true constants
- Files: kebab-case (`app.ts`, `base.ts`)

### Functions
- Async functions return `Promise<T>`
- Export named functions, not default exports
- Factory functions use `create` prefix: `createCommands`, `createInitialState`

### Error Handling
```typescript
try {
  await operation();
} catch (error) {
  const msg = error instanceof Error ? error.message : 'Unknown error';
  console.error(`Error: ${msg}`);
}
```

### Async Patterns
- Use `for await...of` for async generators
- Streaming via `AsyncGenerator<StreamChunk, void, unknown>`
- Always handle promise rejections

## CLI Options

```bash
-p, --provider <name>    # Override provider
-m, --model <name>       # Override model
-c, --config <path>      # Config file path
-e, --execute <mode>     # Set shell command execution: on or off
--no-mcp                 # Disable MCP for this run
```

## Configuration

Config location: `~/.askai/settings.json`

```json
{
  "provider": "llama.cpp",
  "providers": {
    "llama.cpp": { "api_key": "...", "model": "...", "base_url": "..." },
    "openai": { "api_key": "...", "model": "gpt-4o" },
    "anthropic": { "api_key": "...", "model": "claude-sonnet-4-20250514" }
  },
  "allowExecute": true,
  "mcpServers": {
    "server-name": { "command": "npx", "args": [...] }
  }
}
```

## Key Patterns

### Provider Interface
```typescript
interface Provider {
  readonly name: string;
  readonly model: string;
  chat(messages: Message[], tools?): AsyncGenerator<StreamChunk>;
}
```

### Message Format
```typescript
interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}
```

### Command Definition
```typescript
interface Command {
  name: string;
  description: string;
  action: () => string | void;
}
```
