import { Config, MCPServerConfig } from '../config';
import { MCPClientWrapper, MCPTool, MCPToolResult } from './client';

export type MCPServerLifecycle = 'disconnected' | 'connecting' | 'connected' | 'disconnecting' | 'refreshing' | 'error';

export interface MCPServerState {
  name: string;
  connected: boolean;
  autoConnect: boolean;
  lifecycle: MCPServerLifecycle;
  operationStartedAt?: number;
  toolCount: number;
  transport: 'stdio' | 'http' | 'unknown';
  target: string;
  tools: MCPTool[];
  recentStderr: string[];
  lastError?: string;
}

export class MCPManager {
  private servers: Map<string, MCPClientWrapper> = new Map();
  private serverConfigs: Map<string, MCPServerConfig> = new Map();
  private serverTools: Map<string, MCPTool[]> = new Map();
  private toolToServer: Map<string, string> = new Map();
  private lastErrors: Map<string, string> = new Map();
  private lifecycleStates: Map<string, MCPServerLifecycle> = new Map();
  private operationStartedAt: Map<string, number> = new Map();

  constructor(config: Config) {
    if (config.mcpServers) {
      for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
        this.serverConfigs.set(name, serverConfig);
        this.lifecycleStates.set(name, 'disconnected');
      }
    }
  }

  get hasServers(): boolean {
    return this.serverConfigs.size > 0;
  }

  async connectAll(): Promise<void> {
    for (const name of this.serverConfigs.keys()) {
      await this.connectServer(name);
    }
    await this.refreshTools();
  }

  async connectAutoConnect(): Promise<void> {
    for (const [name, config] of this.serverConfigs.entries()) {
      if (!config.autoConnect) {
        continue;
      }
      await this.connectServer(name);
    }
    await this.refreshTools();
  }

  async connectServer(name: string): Promise<void> {
    const config = this.serverConfigs.get(name);
    if (!config) {
      throw new Error(`MCP server "${name}" is not configured`);
    }

    const existing = this.servers.get(name);
    if (existing?.connected) {
      return;
    }

    const client = new MCPClientWrapper(name);
    this.setLifecycle(name, 'connecting');
    try {
      await client.connect(config);
      this.servers.set(name, client);
      this.lastErrors.delete(name);
      this.setLifecycle(name, 'connected');
    } catch (error) {
      this.lastErrors.set(name, error instanceof Error ? error.message : 'Unknown error');
      this.setLifecycle(name, 'error');
      throw error;
    }
  }

  async disconnectServer(name: string): Promise<void> {
    const client = this.servers.get(name);
    if (client) {
      this.setLifecycle(name, 'disconnecting');
      try {
        await client.disconnect();
      } finally {
        this.servers.delete(name);
      }
    }

    this.serverTools.delete(name);
    for (const [toolName, serverName] of this.toolToServer.entries()) {
      if (serverName === name) {
        this.toolToServer.delete(toolName);
      }
    }
    this.setLifecycle(name, 'disconnected');
  }

  async reconnectServer(name: string): Promise<void> {
    await this.disconnectServer(name);
    await this.connectServer(name);
    await this.refreshTools();
  }

  async disconnectAll(): Promise<void> {
    for (const name of Array.from(this.servers.keys())) {
      await this.disconnectServer(name);
    }
  }

  async refreshTools(): Promise<void> {
    this.serverTools.clear();
    this.toolToServer.clear();

    for (const [serverName, client] of this.servers) {
      if (!client.connected) {
        continue;
      }

      this.setLifecycle(serverName, 'refreshing');
      try {
        const tools = await client.listTools();
        this.serverTools.set(serverName, tools);
        for (const tool of tools) {
          this.toolToServer.set(tool.name, serverName);
        }
        this.lastErrors.delete(serverName);
        this.setLifecycle(serverName, 'connected');
      } catch (error) {
        this.serverTools.set(serverName, []);
        this.lastErrors.set(serverName, error instanceof Error ? error.message : 'Unknown error');
        this.setLifecycle(serverName, 'error');
      }
    }
  }

  listAllTools(): Promise<MCPTool[]> {
    return Promise.resolve(
      Array.from(this.serverTools.values()).flat()
    );
  }

  listServerStates(): MCPServerState[] {
    return Array.from(this.serverConfigs.entries()).map(([name, config]) => {
      const client = this.servers.get(name);
      const tools = this.serverTools.get(name) || [];
      return {
        name,
        connected: client?.connected ?? false,
        autoConnect: config.autoConnect ?? false,
        lifecycle: this.lifecycleStates.get(name) || (client?.connected ? 'connected' : 'disconnected'),
        operationStartedAt: this.operationStartedAt.get(name),
        toolCount: tools.length,
        transport: config.url ? 'http' : config.command ? 'stdio' : 'unknown',
        target: config.url || [config.command, ...(config.args || [])].filter(Boolean).join(' '),
        tools,
        recentStderr: client?.recentStderr || [],
        lastError: this.lastErrors.get(name),
      };
    });
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    let serverName = this.toolToServer.get(toolName);
    if (!serverName) {
      await this.refreshTools();
      serverName = this.toolToServer.get(toolName);
    }

    if (!serverName) {
      throw new Error(`Tool "${toolName}" not found in any connected MCP server`);
    }

    const client = this.servers.get(serverName);
    if (!client?.connected) {
      throw new Error(`MCP server "${serverName}" is not connected`);
    }

    return await client.callTool(toolName, args);
  }
  getServerForTool(toolName: string): string | undefined {
    return this.toolToServer.get(toolName);
  }

  private setLifecycle(name: string, lifecycle: MCPServerLifecycle): void {
    this.lifecycleStates.set(name, lifecycle);
    if (lifecycle === 'connected' || lifecycle === 'disconnected' || lifecycle === 'error') {
      this.operationStartedAt.delete(name);
      return;
    }
    this.operationStartedAt.set(name, Date.now());
  }
}
