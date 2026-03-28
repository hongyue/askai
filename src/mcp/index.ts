import { Config, MCPServerConfig } from '../config';
import { MCPClientWrapper, MCPTool, MCPToolResult } from './client';

export interface MCPManagerOptions {
  autoExecute?: boolean;
}

export class MCPManager {
  private servers: Map<string, MCPClientWrapper> = new Map();
  private serverConfigs: Map<string, MCPServerConfig> = new Map();
  private globalAutoExecute: boolean;

  constructor(config: Config) {
    this.globalAutoExecute = config.mcp?.autoExecute ?? false;
    
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
    if (!this.hasServers) {
      return;
    }

    console.log('Connecting to MCP servers...');

    for (const [name, config] of this.serverConfigs) {
      try {
        const client = new MCPClientWrapper(name);
        await client.connect(config);
        this.servers.set(name, client);
        console.log(`  ✓ ${name}`);
      } catch (error) {
        console.log(`  ✗ ${name}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    if (this.servers.size > 0) {
      console.log('');
    }
  }

  async disconnectAll(): Promise<void> {
    for (const [name, client] of this.servers) {
      try {
        await client.disconnect();
      } catch (error) {
        // Ignore disconnect errors
      }
    }
    this.servers.clear();
  }

  async listAllTools(): Promise<MCPTool[]> {
    const tools: MCPTool[] = [];

    for (const [serverName, client] of this.servers) {
      if (!client.connected) continue;
      
      try {
        const serverTools = await client.listTools();
        tools.push(...serverTools);
      } catch (error) {
        console.log(`Warning: Failed to list tools from "${serverName}": ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    return tools;
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    // Find the server that has this tool
    for (const [serverName, client] of this.servers) {
      if (!client.connected) continue;
      
      try {
        const tools = await client.listTools();
        const tool = tools.find(t => t.name === toolName);
        
        if (tool) {
          return await client.callTool(toolName, args);
        }
      } catch (error) {
        // Continue to next server
      }
    }

    throw new Error(`Tool "${toolName}" not found in any connected MCP server`);
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
    for (const [serverName, client] of this.servers) {
      if (!client.connected) continue;
      // We'll find the server when we list tools
      return serverName;
    }
    return undefined;
  }
}
