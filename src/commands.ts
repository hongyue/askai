export interface SessionState {
  allowExecute: boolean;
  mcpEnabled: boolean;
}

export interface Command {
  name: string;
  description: string;
  action: (args: string[]) => Promise<string | void> | string | void;
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
  onProviderCommand?: (args: string[]) => Promise<string | void>,
  onModelCommand?: (args: string[]) => Promise<string | void>,
): Command[] {
  return [
    {
      name: 'provider',
      description: 'manage the providers',
      action: (args) => onProviderCommand?.(args),
    },
    {
      name: 'model',
      description: 'select what model to use',
      action: (args) => onModelCommand?.(args),
    },
    {
      name: 'shell-execute',
      description: 'toggle shell command execution',
      action: () => {
        state.allowExecute = !state.allowExecute;
        const status = state.allowExecute ? 'enabled' : 'disabled';
        onStateChange();
        return `Command execution: ${status}`;
      },
    },
    {
      name: 'mcp',
      description: 'manage MCP servers',
      action: () => {
        onOpenMcpModal?.();
        return 'Opened the MCP servers manager';
      },
    },
    {
      name: 'clear',
      description: 'clear the screen',
      action: () => {
        onClear?.();
      },
    },
    {
      name: 'exit',
      description: 'exit askai',
      action: () => {
        // This is handled specially in the app
      },
    },
    {
      name: 'quit',
      description: 'exit askai',
      action: () => {
        // This is handled specially in the app
      },
    },
  ];
}
