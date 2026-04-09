import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { MCPServerConfig } from '../config';
import { appVersion } from '../version';

const ansiEscapePattern = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const maxStderrLines = 100;

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
  private stderrBuffer = '';
  private stderrLines: string[] = [];

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

  get recentStderr(): string[] {
    return [...this.stderrLines];
  }

  async connect(config: MCPServerConfig): Promise<void> {
    try {
      if (config.url) {
        this.transport = new StreamableHTTPClientTransport(new URL(config.url));
      } else if (config.command) {
        this.transport = new StdioClientTransport({
          command: config.command,
          args: config.args || [],
          stderr: 'pipe',
        });
        this.attachStderrListener(this.transport);
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
      this.flushStderrBuffer();
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

  private attachStderrListener(transport: StdioClientTransport): void {
    const stderr = transport.stderr;
    if (!stderr) {
      return;
    }

    stderr.on('data', (chunk: string | Buffer) => {
      this.consumeStderrChunk(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });
  }

  private consumeStderrChunk(chunk: string): void {
    this.stderrBuffer += chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const parts = this.stderrBuffer.split('\n');
    this.stderrBuffer = parts.pop() || '';

    for (const part of parts) {
      const line = part.replace(ansiEscapePattern, '').trim();
      if (!line) {
        continue;
      }
      this.stderrLines.push(line);
    }

    if (this.stderrLines.length > maxStderrLines) {
      this.stderrLines.splice(0, this.stderrLines.length - maxStderrLines);
    }
  }

  private flushStderrBuffer(): void {
    const line = this.stderrBuffer.replace(ansiEscapePattern, '').trim();
    if (line) {
      this.stderrLines.push(line);
      if (this.stderrLines.length > maxStderrLines) {
        this.stderrLines.splice(0, this.stderrLines.length - maxStderrLines);
      }
    }
    this.stderrBuffer = '';
  }
}
