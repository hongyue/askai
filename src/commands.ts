export interface SessionState {
  allowExecute: boolean;
  mcpEnabled: boolean;
}

export interface Command {
  name: string;
  description: string;
  action: () => string | void;
}

export function createInitialState(allowExecute: boolean, mcpEnabled: boolean): SessionState {
  return {
    allowExecute,
    mcpEnabled,
  };
}

export function createCommands(state: SessionState, onStateChange: () => void): Command[] {
  return [
    {
      name: 'toggle-execute',
      description: 'Toggle shell command execution',
      action: () => {
        state.allowExecute = !state.allowExecute;
        const status = state.allowExecute ? 'enabled' : 'disabled';
        onStateChange();
        return `Command execution: ${status}`;
      },
    },
    {
      name: 'toggle-mcp',
      description: 'Toggle MCP tools',
      action: () => {
        state.mcpEnabled = !state.mcpEnabled;
        const status = state.mcpEnabled ? 'enabled' : 'disabled';
        onStateChange();
        return `MCP tools: ${status}`;
      },
    },
    {
      name: 'help',
      description: 'Show available commands',
      action: () => {
        return `Available commands:
  /toggle-execute - Toggle shell command execution
  /toggle-mcp - Toggle MCP tools
  /help - Show available commands
  /exit - Exit interactive mode`;
      },
    },
    {
      name: 'exit',
      description: 'Exit interactive mode',
      action: () => {
        // This is handled specially in the app
      },
    },
  ];
}
