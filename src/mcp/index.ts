import { Config, MCPServerConfig } from '../config';
import { MCPClientWrapper, MCPTool, MCPToolResult } from './client';

export interface MCPServerState {
  name: string;
  connected: boolean;
  autoConnect: boolean;
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
  private lastErrors: Map<string, string> = new Map();

  constructor(config: Config) {
    if (config.mcpServers) {
      for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
        this.serverConfigs.set(name, serverConfig);
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
    try {
      await client.connect(config);
      this.servers.set(name, client);
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

  listServerStates(): MCPServerState[] {
    return Array.from(this.serverConfigs.entries()).map(([name, config]) => {
      const client = this.servers.get(name);
      const tools = this.serverTools.get(name) || [];
      return {
        name,
        connected: client?.connected ?? false,
        autoConnect: config.autoConnect ?? false,
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

    const client = this.servers.get(serverName);
    if (!client?.connected) {
      throw new Error(`MCP server "${serverName}" is not connected`);
    }

    return await client.callTool(toolName, args);
  }
  getServerForTool(toolName: string): string | undefined {
    return this.toolToServer.get(toolName);
  }
}
