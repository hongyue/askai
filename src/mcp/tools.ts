import { MCPTool } from './client';

export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties?: Record<string, object>;
      required?: string[];
    };
  };
}

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties?: Record<string, object>;
    required?: string[];
  };
}

export function convertToOpenAITools(tools: MCPTool[]): OpenAITool[] {
  return tools.map(tool => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        properties: tool.inputSchema.properties,
        required: tool.inputSchema.required,
      },
    },
  }));
}

export function convertToAnthropicTools(tools: MCPTool[]): AnthropicTool[] {
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: 'object' as const,
      properties: tool.inputSchema.properties,
      required: tool.inputSchema.required,
    },
  }));
}

export function formatToolResult(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter(c => c.type === 'text' && c.text)
    .map(c => c.text)
    .join('\n');
}
