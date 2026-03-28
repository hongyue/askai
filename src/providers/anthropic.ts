import Anthropic from '@anthropic-ai/sdk';
import { ProviderConfig } from '../config';
import { Message, StreamChunk, Provider, ToolCall } from './base';
import { AnthropicTool } from '../mcp/tools';

export class AnthropicProvider implements Provider {
  readonly name: string;
  readonly model: string;
  private client: Anthropic;
  
  constructor(config: ProviderConfig, name?: string) {
    this.name = name || 'anthropic';
    this.model = config.model;
    this.client = new Anthropic({
      apiKey: config.api_key,
    });
  }
  
  async *chat(messages: Message[], tools?: AnthropicTool[]): AsyncGenerator<StreamChunk, void, unknown> {
    try {
      // Separate system message from other messages
      const systemMessage = messages.find(m => m.role === 'system');
      const chatMessages = messages
        .filter(m => m.role !== 'system')
        .map(m => {
          if (m.role === 'tool') {
            return {
              role: 'user' as const,
              content: [
                {
                  type: 'tool_result' as const,
                  tool_use_id: m.tool_call_id || '',
                  content: m.content,
                },
              ],
            };
          }
          
          if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
            const content: any[] = [];
            if (m.content) {
              content.push({ type: 'text', text: m.content });
            }
            for (const tc of m.tool_calls) {
              content.push({
                type: 'tool_use',
                id: tc.id,
                name: tc.name,
                input: JSON.parse(tc.arguments || '{}'),
              });
            }
            return { role: 'assistant' as const, content };
          }
          
          return { role: m.role as 'user' | 'assistant', content: m.content };
        });
      
      const params: any = {
        model: this.model,
        max_tokens: 4096,
        system: systemMessage?.content || '',
        messages: chatMessages,
      };

      if (tools && tools.length > 0) {
        params.tools = tools;
      }
      
      const stream = this.client.messages.stream(params);
      
      let toolCalls: ToolCall[] = [];
      let currentToolCall: Partial<ToolCall> | null = null;
      
      for await (const event of stream) {
        if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
          currentToolCall = {
            id: event.content_block.id,
            name: event.content_block.name,
            arguments: '',
          };
        }
        
        if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            yield { content: event.delta.text, done: false };
          } else if (event.delta.type === 'input_json_delta' && currentToolCall) {
            currentToolCall.arguments = (currentToolCall.arguments || '') + event.delta.partial_json;
          }
        }
        
        if (event.type === 'content_block_stop' && currentToolCall) {
          toolCalls.push(currentToolCall as ToolCall);
          currentToolCall = null;
        }
        
        if (event.type === 'message_stop') {
          yield { 
            content: '', 
            done: true,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
          };
          return;
        }
      }
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Anthropic API error: ${error.message}`);
      }
      throw error;
    }
  }
  
  async chatComplete(messages: Message[], tools?: AnthropicTool[]): Promise<Message> {
    try {
      // Separate system message from other messages
      const systemMessage = messages.find(m => m.role === 'system');
      const chatMessages = messages
        .filter(m => m.role !== 'system')
        .map(m => {
          if (m.role === 'tool') {
            return {
              role: 'user' as const,
              content: [
                {
                  type: 'tool_result' as const,
                  tool_use_id: m.tool_call_id || '',
                  content: m.content,
                },
              ],
            };
          }
          
          if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
            const content: any[] = [];
            if (m.content) {
              content.push({ type: 'text', text: m.content });
            }
            for (const tc of m.tool_calls) {
              content.push({
                type: 'tool_use',
                id: tc.id,
                name: tc.name,
                input: JSON.parse(tc.arguments || '{}'),
              });
            }
            return { role: 'assistant' as const, content };
          }
          
          return { role: m.role as 'user' | 'assistant', content: m.content };
        });
      
      const params: any = {
        model: this.model,
        max_tokens: 4096,
        system: systemMessage?.content || '',
        messages: chatMessages,
      };

      if (tools && tools.length > 0) {
        params.tools = tools;
      }
      
      const response = await this.client.messages.create(params);
      
      const result: Message = {
        role: 'assistant',
        content: '',
      };

      const toolCalls: ToolCall[] = [];
      const textParts: string[] = [];

      for (const block of response.content) {
        if (block.type === 'text') {
          textParts.push(block.text);
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input),
          });
        }
      }

      result.content = textParts.join('');
      if (toolCalls.length > 0) {
        result.tool_calls = toolCalls;
      }

      return result;
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Anthropic API error: ${error.message}`);
      }
      throw error;
    }
  }
}
