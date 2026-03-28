import { loadConfig } from './config';
import { createProviderFromConfig } from './chat';
import { MCPManager } from './mcp';
import { createInitialState, createCommands } from './commands';
import { Message, Provider, ToolCall } from './providers/base';
import { MCPTool } from './mcp/client';
import { convertToOpenAITools, convertToAnthropicTools, formatToolResult } from './mcp/tools';
import { detectCodeBlocks } from './shell';
import { readInput } from './input';

interface AppOptions {
  providerName?: string;
  modelName?: string;
  configPath?: string;
  allowExecute: boolean;
  mcpEnabled: boolean;
  question?: string;
}

export async function runApp(options: AppOptions): Promise<void> {
  const config = await loadConfig(options.configPath);
  
  if (options.providerName) {
    if (!config.providers[options.providerName]) {
      throw new Error(`Provider "${options.providerName}" not found`);
    }
    config.provider = options.providerName;
  }
  
  if (options.modelName) {
    config.providers[config.provider].model = options.modelName;
  }
  
  let mcpManager: MCPManager | undefined;
  let mcpTools: MCPTool[] = [];
  
  if (options.mcpEnabled && config.mcpServers && Object.keys(config.mcpServers).length > 0) {
    mcpManager = new MCPManager(config);
    await mcpManager.connectAll();
    mcpTools = await mcpManager.listAllTools();
  }
  
  const provider = await createProviderFromConfig(config);
  const systemPrompt = config.system_prompt || 'You are a helpful terminal assistant.';
  const state = createInitialState(options.allowExecute, options.mcpEnabled);
  const commands = createCommands(state, () => {});
  
  function convertToolsForProvider(tools: MCPTool[]): any[] {
    if (tools.length === 0) return [];
    switch (provider.name) {
      case 'openai':
      case 'llama':
      case 'ollama':
        return convertToOpenAITools(tools);
      case 'anthropic':
        return convertToAnthropicTools(tools);
      default:
        return [];
    }
  }
  
  let providerTools = convertToolsForProvider(mcpTools);
  const messages: Message[] = [{ role: 'system', content: systemPrompt }];
  
  // Oneshot mode
  if (options.question) {
    messages.push({ role: 'user', content: options.question });
    const toolsToUse = state.mcpEnabled ? providerTools : [];
    
    try {
      for await (const chunk of provider.chat(messages, toolsToUse.length > 0 ? toolsToUse : undefined)) {
        if (chunk.content) process.stdout.write(chunk.content);
        if (chunk.done) break;
      }
      console.log('');
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
    
    if (mcpManager) await mcpManager.disconnectAll();
    return;
  }
  
  // Interactive mode with readline
  console.log(`Welcome to askai! (${provider.name} / ${provider.model})`);
  console.log('Type your question or "exit" to quit. Type "/" for commands.\n');
  
  while (true) {
    const result = await readInput(commands);
    
    if (result.type === 'exit') {
      console.log('Goodbye!');
      break;
    }
    
    if (result.type === 'command') continue;
    if (!result.value.trim()) continue;
    
    messages.push({ role: 'user', content: result.value });
    const toolsToUse = state.mcpEnabled ? providerTools : [];
    
    console.log('\nThinking...\n');
    
    try {
      let fullResponse = '';
      let toolCalls: ToolCall[] | undefined;
      
      for await (const chunk of provider.chat(messages, toolsToUse.length > 0 ? toolsToUse : undefined)) {
        if (chunk.content) {
          process.stdout.write(chunk.content);
          fullResponse += chunk.content;
        }
        if (chunk.tool_calls) toolCalls = chunk.tool_calls;
        if (chunk.done) break;
      }
      
      console.log('\n');
      
      if (toolCalls && toolCalls.length > 0 && mcpManager) {
        for (const toolCall of toolCalls) {
          console.log(`\nTool Call: ${toolCall.name}`);
          
          const mcpTool = mcpTools.find(t => t.name === toolCall.name);
          if (mcpTool) {
            try {
              const args = JSON.parse(toolCall.arguments || '{}');
              const result = await mcpManager.callTool(toolCall.name, args);
              console.log(formatToolResult(result));
            } catch (error) {
              console.log(`Error: ${error instanceof Error ? error.message : 'Unknown'}`);
            }
          }
        }
      }
      
      if (fullResponse) {
        messages.push({ role: 'assistant', content: fullResponse });
      }
    } catch (error) {
      console.error(`\nError: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
  
  if (mcpManager) await mcpManager.disconnectAll();
}
