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

export function createCommands(
  state: SessionState,
  onStateChange: () => void,
  onClear?: () => void,
  onOpenMcpModal?: () => void,
): Command[] {
  return [
    {
      name: 'shell-execute',
      description: 'Toggle shell command execution',
      action: () => {
        state.allowExecute = !state.allowExecute;
        const status = state.allowExecute ? 'enabled' : 'disabled';
        onStateChange();
        return `Command execution: ${status}`;
      },
    },
    {
      name: 'mcp',
      description: 'Manage the MCP servers',
      action: () => {
        onOpenMcpModal?.();
        return 'Opened the MCP servers manager';
      },
    },
    {
      name: 'clear',
      description: 'Clear the screen',
      action: () => {
        onClear?.();
      },
    },
    {
      name: 'exit',
      description: 'Exit the application',
      action: () => {
        // This is handled specially in the app
      },
    },
  ];
}
