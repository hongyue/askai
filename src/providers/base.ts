import { ResolvedProviderConfig } from '../config';
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

export interface ChatOptions {
  signal?: AbortSignal;
}

export interface Provider {
  readonly name: string;
  readonly label: string;
  readonly model: string;
  
  chat(messages: Message[], tools?: OpenAITool[] | AnthropicTool[], options?: ChatOptions): AsyncGenerator<StreamChunk, void, unknown>;
  chatComplete(messages: Message[], tools?: OpenAITool[] | AnthropicTool[], options?: ChatOptions): Promise<Message>;
}

export interface ProviderConstructor {
  new (config: ResolvedProviderConfig, name?: string, label?: string): Provider;
}
