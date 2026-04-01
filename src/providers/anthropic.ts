import Anthropic from '@anthropic-ai/sdk';
import type { Beta } from '@anthropic-ai/sdk/resources/index';
import { ResolvedProviderConfig } from '../config';
import { ChatOptions, Message, StreamChunk, Provider, ToolCall } from './base';
import { AnthropicTool } from '../mcp/tools';

type AnthropicToolsMessageParam = Beta.Tools.ToolsBetaMessageParam;
type AnthropicToolUseBlock = Beta.Tools.ToolUseBlock;

export class AnthropicProvider implements Provider {
  readonly name: string;
  readonly label: string;
  readonly model: string;
  private client: Anthropic;
  
  constructor(config: ResolvedProviderConfig, name?: string, label?: string) {
    this.name = name || 'anthropic';
    this.label = label || config.id || this.name;
    this.model = config.model;
    this.client = new Anthropic({
      apiKey: config.api_key,
      baseURL: config.base_url,
    });
  }
  
  async *chat(messages: Message[], tools?: AnthropicTool[], options?: ChatOptions): AsyncGenerator<StreamChunk, void, unknown> {
    if (tools && tools.length > 0) {
      const response = await this.chatComplete(messages, tools, options);
      yield {
        content: response.content,
        done: true,
        tool_calls: response.tool_calls,
      };
      return;
    }

    try {
      const systemMessage = messages.find(m => m.role === 'system');
      const chatMessages = messages
        .filter((m): m is Message & { role: 'user' | 'assistant' } => m.role === 'user' || m.role === 'assistant')
        .map(m => ({ role: m.role, content: m.content }));

      const params: Anthropic.MessageStreamParams = {
        model: this.model,
        max_tokens: 4096,
        system: systemMessage?.content || '',
        messages: chatMessages,
      };
      const stream = this.client.messages.stream(params, {
        signal: options?.signal,
      });

      for await (const event of stream) {
        if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            yield { content: event.delta.text, done: false };
          }
        }

        if (event.type === 'message_stop') {
          yield { content: '', done: true };
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
  
  async chatComplete(messages: Message[], tools?: AnthropicTool[], options?: ChatOptions): Promise<Message> {
    try {
      const systemMessage = messages.find(m => m.role === 'system');
      const chatMessages = messages
        .filter(m => m.role !== 'system')
        .map<AnthropicToolsMessageParam>(m => {
          if (m.role === 'tool') {
            return {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: m.tool_call_id || '',
                  content: [{ type: 'text', text: m.content }],
                },
              ],
            };
          }

          if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
            const content: Array<{ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown }> = [];
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
            return { role: 'assistant', content };
          }

          return {
            role: m.role as 'user' | 'assistant',
            content: m.content,
          };
        });

      const response = tools && tools.length > 0
        ? await this.client.beta.tools.messages.create({
            model: this.model,
            max_tokens: 4096,
            system: systemMessage?.content || '',
            messages: chatMessages,
            tools,
          }, {
            signal: options?.signal,
          })
        : await this.client.messages.create({
            model: this.model,
            max_tokens: 4096,
            system: systemMessage?.content || '',
            messages: chatMessages.filter(
              (m): m is Anthropic.MessageParam => typeof m.content === 'string'
            ),
          }, {
            signal: options?.signal,
          });
      
      const result: Message = {
        role: 'assistant',
        content: '',
      };

      const toolCalls: ToolCall[] = [];
      const textParts: string[] = [];

      for (const block of response.content) {
        if (block.type === 'text') {
          textParts.push(block.text);
        } else if ('name' in block && 'id' in block && 'input' in block) {
          const toolBlock = block as AnthropicToolUseBlock;
          toolCalls.push({
            id: toolBlock.id,
            name: toolBlock.name,
            arguments: JSON.stringify(toolBlock.input),
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
