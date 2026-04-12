export interface SessionState {
  allowExecute: boolean;
}

export interface Command {
  name: string;
  description: string;
  action: (args: string[]) => Promise<string | void> | string | void;
}

export function createInitialState(allowExecute: boolean): SessionState {
  return {
    allowExecute,
  };
}

export function createCommands(
  state: SessionState,
  onStateChange: () => void,
  onClear?: () => void,
  onOpenMcpModal?: () => void,
  onProviderCommand?: (args: string[]) => Promise<string | void>,
  onModelCommand?: (args: string[]) => Promise<string | void>,
  onNewSession?: () => Promise<string | void>,
  onOpenSessionsModal?: () => void,
  onTopicsCommand?: (args: string[]) => Promise<string | void>,
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
      name: 'command-execute',
      description: 'toggle automatic command execution',
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
      name: 'new',
      description: 'start a new session',
      action: async () => {
        return await onNewSession?.();
      },
    },
    {
      name: 'sessions',
      description: 'manage sessions',
      action: () => {
        onOpenSessionsModal?.();
        return 'Opened the sessions manager';
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
      name: 'topics',
      description: 'browse user topics',
      action: async (args) => {
        return await onTopicsCommand?.(args);
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
