import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { MCPServerConfig } from '../config';
import { appVersion } from '../version';

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, object>;
    required?: string[];
  };
  serverName: string;
}

export interface MCPToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

export class MCPClientWrapper {
  private client: Client;
  private transport: StdioClientTransport | StreamableHTTPClientTransport | null = null;
  private serverName: string;
  private _connected = false;

  constructor(serverName: string) {
    this.serverName = serverName;
    this.client = new Client(
      { name: 'askai-client', version: appVersion },
      { capabilities: {} }
    );
  }

  get connected(): boolean {
    return this._connected;
  }

  async connect(config: MCPServerConfig): Promise<void> {
    try {
      if (config.url) {
        this.transport = new StreamableHTTPClientTransport(new URL(config.url));
      } else if (config.command) {
        this.transport = new StdioClientTransport({
          command: config.command,
          args: config.args || [],
        });
      } else {
        throw new Error('Either url or command must be specified');
      }

      await this.client.connect(this.transport);
      this._connected = true;
    } catch (error) {
      this._connected = false;
      throw new Error(`Failed to connect to MCP server "${this.serverName}": ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async disconnect(): Promise<void> {
    if (this.transport) {
      await this.transport.close();
      this._connected = false;
      this.transport = null;
    }
  }

  async listTools(): Promise<MCPTool[]> {
    if (!this._connected) {
      throw new Error(`MCP server "${this.serverName}" is not connected`);
    }

    const result = await this.client.listTools();
    return result.tools.map(tool => ({
      name: tool.name,
      description: tool.description || '',
      inputSchema: tool.inputSchema as MCPTool['inputSchema'],
      serverName: this.serverName,
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    if (!this._connected) {
      throw new Error(`MCP server "${this.serverName}" is not connected`);
    }

    const result = await this.client.callTool({ name, arguments: args });
    return {
      content: result.content as MCPToolResult['content'],
      isError: typeof result.isError === 'boolean' ? result.isError : undefined,
    };
  }
}
