import { Config, MCPServerConfig } from '../config';
import { MCPClientWrapper, MCPTool, MCPToolResult } from './client';

export interface MCPManagerOptions {
  autoExecute?: boolean;
}

export interface MCPServerState {
  name: string;
  connected: boolean;
  enabled: boolean;
  toolCount: number;
  transport: 'stdio' | 'http' | 'unknown';
  target: string;
  tools: MCPTool[];
  lastError?: string;
}

export class MCPManager {
  private servers: Map<string, MCPClientWrapper> = new Map();
  private serverConfigs: Map<string, MCPServerConfig> = new Map();
  private serverTools: Map<string, MCPTool[]> = new Map();
  private toolToServer: Map<string, string> = new Map();
  private enabledServers: Set<string> = new Set();
  private lastErrors: Map<string, string> = new Map();
  private globalAutoExecute: boolean;

  constructor(config: Config) {
    this.globalAutoExecute = config.mcp?.autoExecute ?? false;

    if (config.mcpServers) {
      for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
        this.serverConfigs.set(name, serverConfig);
        this.enabledServers.add(name);
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
    try {
      await client.connect(config);
      this.servers.set(name, client);
      this.enabledServers.add(name);
      this.lastErrors.delete(name);
    } catch (error) {
      this.lastErrors.set(name, error instanceof Error ? error.message : 'Unknown error');
      throw error;
    }
  }

  async disconnectServer(name: string): Promise<void> {
    const client = this.servers.get(name);
    if (client) {
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

  setServerEnabled(name: string, enabled: boolean): void {
    if (!this.serverConfigs.has(name)) {
      throw new Error(`MCP server "${name}" is not configured`);
    }

    if (enabled) {
      this.enabledServers.add(name);
    } else {
      this.enabledServers.delete(name);
    }
  }

  isServerEnabled(name: string): boolean {
    return this.enabledServers.has(name);
  }

  setAllEnabled(enabled: boolean): void {
    if (enabled) {
      for (const name of this.serverConfigs.keys()) {
        this.enabledServers.add(name);
      }
    } else {
      this.enabledServers.clear();
    }
  }

  async refreshTools(): Promise<void> {
    this.serverTools.clear();
    this.toolToServer.clear();

    for (const [serverName, client] of this.servers) {
      if (!client.connected) {
        continue;
      }

      try {
        const tools = await client.listTools();
        this.serverTools.set(serverName, tools);
        for (const tool of tools) {
          this.toolToServer.set(tool.name, serverName);
        }
        this.lastErrors.delete(serverName);
      } catch (error) {
        this.serverTools.set(serverName, []);
        this.lastErrors.set(serverName, error instanceof Error ? error.message : 'Unknown error');
      }
    }
  }

  listAllTools(): Promise<MCPTool[]> {
    return Promise.resolve(
      Array.from(this.serverTools.values()).flat()
    );
  }

  listEnabledTools(): Promise<MCPTool[]> {
    return Promise.resolve(
      Array.from(this.serverTools.entries())
        .filter(([serverName]) => this.enabledServers.has(serverName))
        .flatMap(([, tools]) => tools)
    );
  }

  listServerStates(): MCPServerState[] {
    return Array.from(this.serverConfigs.entries()).map(([name, config]) => {
      const client = this.servers.get(name);
      const tools = this.serverTools.get(name) || [];
      return {
        name,
        connected: client?.connected ?? false,
        enabled: this.enabledServers.has(name),
        toolCount: tools.length,
        transport: config.url ? 'http' : config.command ? 'stdio' : 'unknown',
        target: config.url || [config.command, ...(config.args || [])].filter(Boolean).join(' '),
        tools,
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
    if (!this.enabledServers.has(serverName)) {
      throw new Error(`Tool "${toolName}" is disabled because MCP server "${serverName}" is disabled`);
    }

    const client = this.servers.get(serverName);
    if (!client?.connected) {
      throw new Error(`MCP server "${serverName}" is not connected`);
    }

    return await client.callTool(toolName, args);
  }

  shouldAutoExecute(serverName?: string): boolean {
    if (serverName) {
      const config = this.serverConfigs.get(serverName);
      if (config?.autoExecute !== undefined) {
        return config.autoExecute;
      }
    }
    return this.globalAutoExecute;
  }

  getServerForTool(toolName: string): string | undefined {
    return this.toolToServer.get(toolName);
  }
}
