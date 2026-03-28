import OpenAI from 'openai';
import { ProviderConfig } from '../config';
import { Message, StreamChunk, Provider, ToolCall } from './base';
import { OpenAITool } from '../mcp/tools';

export class OpenAIProvider implements Provider {
  readonly name: string;
  readonly model: string;
  private client: OpenAI;
  
  constructor(config: ProviderConfig, name?: string) {
    this.name = name || 'openai';
    this.model = config.model;
    this.client = new OpenAI({
      apiKey: config.api_key,
      baseURL: config.base_url || 'https://api.openai.com/v1',
    });
  }
  
  async *chat(messages: Message[], tools?: OpenAITool[]): AsyncGenerator<StreamChunk, void, unknown> {
    try {
      const request: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
        model: this.model,
        messages: messages.map(m => {
          const msg: OpenAI.Chat.ChatCompletionMessageParam = {
            role: m.role as 'system' | 'user' | 'assistant',
            content: m.content,
          };
          if (m.tool_calls && m.tool_calls.length > 0) {
            (msg as any).tool_calls = m.tool_calls.map(tc => ({
              id: tc.id,
              type: 'function',
              function: {
                name: tc.name,
                arguments: tc.arguments,
              },
            }));
          }
          if (m.role === 'tool' && m.tool_call_id) {
            (msg as any).tool_call_id = m.tool_call_id;
          }
          return msg;
        }),
        stream: true,
      };

      if (tools && tools.length > 0) {
        request.tools = tools;
      }

      const stream = await this.client.chat.completions.create(request);
      
      let toolCalls: ToolCall[] = [];
      
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        const done = chunk.choices[0]?.finish_reason !== null;
        
        // Handle content
        const content = delta?.content || '';
        
        // Handle tool calls
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const index = tc.index ?? 0;
            
            if (!toolCalls[index]) {
              toolCalls[index] = {
                id: tc.id || '',
                name: tc.function?.name || '',
                arguments: '',
              };
            }
            
            if (tc.function?.name) {
              toolCalls[index].name = tc.function.name;
            }
            if (tc.function?.arguments) {
              toolCalls[index].arguments += tc.function.arguments;
            }
            if (tc.id) {
              toolCalls[index].id = tc.id;
            }
          }
        }
        
        yield { 
          content, 
          done,
          tool_calls: toolCalls.length > 0 && done ? toolCalls : undefined,
        };
        
        if (done) {
          return;
        }
      }
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`OpenAI API error: ${error.message}`);
      }
      throw error;
    }
  }
  
  async chatComplete(messages: Message[], tools?: OpenAITool[]): Promise<Message> {
    try {
      const request: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
        model: this.model,
        messages: messages.map(m => {
          const msg: OpenAI.Chat.ChatCompletionMessageParam = {
            role: m.role as 'system' | 'user' | 'assistant',
            content: m.content,
          };
          if (m.tool_calls && m.tool_calls.length > 0) {
            (msg as any).tool_calls = m.tool_calls.map(tc => ({
              id: tc.id,
              type: 'function',
              function: {
                name: tc.name,
                arguments: tc.arguments,
              },
            }));
          }
          if (m.role === 'tool' && m.tool_call_id) {
            (msg as any).tool_call_id = m.tool_call_id;
          }
          return msg;
        }),
      };

      if (tools && tools.length > 0) {
        request.tools = tools;
      }

      const response = await this.client.chat.completions.create(request);
      const choice = response.choices[0];
      
      const result: Message = {
        role: 'assistant',
        content: choice?.message?.content || '',
      };

      if (choice?.message?.tool_calls && choice.message.tool_calls.length > 0) {
        result.tool_calls = choice.message.tool_calls.map(tc => ({
          id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        }));
      }

      return result;
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`OpenAI API error: ${error.message}`);
      }
      throw error;
    }
  }
}
