import { ProviderConfig } from '../config';
import { OpenAITool, AnthropicTool } from '../mcp/tools';

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface StreamChunk {
  content: string;
  done: boolean;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface Provider {
  readonly name: string;
  readonly model: string;
  
  chat(messages: Message[], tools?: OpenAITool[] | AnthropicTool[]): AsyncGenerator<StreamChunk, void, unknown>;
  chatComplete(messages: Message[], tools?: OpenAITool[] | AnthropicTool[]): Promise<Message>;
}

export interface ProviderConstructor {
  new (config: ProviderConfig): Provider;
}
