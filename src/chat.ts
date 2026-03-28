import inquirer from 'inquirer';
import { Config } from './config';
import { Message, Provider, ToolCall } from './providers/base';
import { OpenAIProvider } from './providers/openai';
import { AnthropicProvider } from './providers/anthropic';
import { detectCodeBlocks, executeCommand, formatCommandResult, askForExecution } from './shell';
import { MCPManager } from './mcp';
import { MCPTool } from './mcp/client';
import { convertToOpenAITools, convertToAnthropicTools, formatToolResult } from './mcp/tools';
import { createInitialState, createCommands } from './commands';
import { readInput } from './input';

export interface ChatOptions {
  provider: Provider;
  systemPrompt: string;
  allowExecute: boolean;
  mcpManager?: MCPManager;
}

export async function createProviderFromConfig(config: Config): Promise<Provider> {
  const providerConfig = config.providers[config.provider];
  
  switch (config.provider) {
    case 'openai':
    case 'llama':
    case 'ollama':
      return new OpenAIProvider(providerConfig, config.provider);
    case 'anthropic':
      return new AnthropicProvider(providerConfig, config.provider);
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}

export async function oneshot(
  options: ChatOptions,
  question: string
): Promise<void> {
  const messages: Message[] = [
    { role: 'system', content: options.systemPrompt },
    { role: 'user', content: question },
  ];

  let mcpTools: MCPTool[] = [];
  if (options.mcpManager) {
    mcpTools = await options.mcpManager.listAllTools();
  }

  const providerTools = convertToolsForProvider(options.provider, mcpTools);

  await runChatLoop(options, messages, providerTools, mcpTools);
}

export async function interactive(options: ChatOptions): Promise<void> {
  const state = createInitialState(options.allowExecute, true);

  let mcpTools: MCPTool[] = [];
  if (options.mcpManager) {
    mcpTools = await options.mcpManager.listAllTools();
  }

  let providerTools = convertToolsForProvider(options.provider, mcpTools);

  const commands = createCommands(state, () => {
    providerTools = state.mcpEnabled ? convertToolsForProvider(options.provider, mcpTools) : [];
  });

  const messages: Message[] = [
    { role: 'system', content: options.systemPrompt },
  ];

  console.log(`Welcome to askai! (${options.provider.name} / ${options.provider.model})`);
  console.log('Type your question or "exit" to quit. Type "/" for commands.\n');

  while (true) {
    const result = await readInput(commands);

    if (result.type === 'exit') {
      console.log('Goodbye!');
      break;
    }

    if (result.type === 'command') {
      continue;
    }

    if (!result.value.trim()) {
      continue;
    }

    messages.push({ role: 'user', content: result.value });

    await runChatLoop(options, messages, providerTools, mcpTools, true, state);
  }

  if (options.mcpManager) {
    await options.mcpManager.disconnectAll();
  }

  process.exit(0);
}

async function runChatLoop(
  options: ChatOptions,
  messages: Message[],
  providerTools: any[],
  mcpTools: MCPTool[],
  isInteractive: boolean = false,
  state?: any
): Promise<void> {
  const MAX_TOOL_ITERATIONS = 10;

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    let fullResponse = '';
    let toolCalls: ToolCall[] | undefined;

    console.log('\nThinking...\n');

    try {
      const toolsToUse = state ? (state.mcpEnabled ? providerTools : []) : providerTools;
      
      for await (const chunk of options.provider.chat(messages, toolsToUse.length > 0 ? toolsToUse : undefined)) {
        if (chunk.content) {
          process.stdout.write(chunk.content);
          fullResponse += chunk.content;
        }

        if (chunk.tool_calls) {
          toolCalls = chunk.tool_calls;
        }

        if (chunk.done) {
          break;
        }
      }

      console.log('\n');

      if (toolCalls && toolCalls.length > 0) {
        messages.push({
          role: 'assistant',
          content: fullResponse,
          tool_calls: toolCalls,
        });

        for (const toolCall of toolCalls) {
          const result = await handleToolCall(options, toolCall, mcpTools);
          messages.push({
            role: 'tool',
            content: result,
            tool_call_id: toolCall.id,
          });
        }

        continue;
      }

      const shouldExecute = state ? state.allowExecute : options.allowExecute;
      if (shouldExecute) {
        await handleCommandExecution(fullResponse);
      }

      if (isInteractive && fullResponse) {
        if (!toolCalls || toolCalls.length === 0) {
          const lastMessage = messages[messages.length - 1];
          if (lastMessage.role !== 'assistant' || lastMessage.content !== fullResponse) {
            messages.push({ role: 'assistant', content: fullResponse });
          }
        }
      }

      return;
    } catch (error) {
      console.error(`\nError: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return;
    }
  }

  console.log('\nWarning: Maximum tool call iterations reached');
}

async function handleToolCall(
  options: ChatOptions,
  toolCall: ToolCall,
  mcpTools: MCPTool[]
): Promise<string> {
  if (!options.mcpManager) {
    return JSON.stringify({ error: 'MCP manager not available' });
  }

  const mcpTool = mcpTools.find(t => t.name === toolCall.name);
  if (!mcpTool) {
    return JSON.stringify({ error: `Tool "${toolCall.name}" not found` });
  }

  let args: Record<string, unknown>;
  try {
    args = JSON.parse(toolCall.arguments || '{}');
  } catch (e) {
    return JSON.stringify({ error: `Invalid tool arguments: ${toolCall.arguments}` });
  }

  const shouldAutoExecute = options.mcpManager.shouldAutoExecute(mcpTool.serverName);

  console.log(`\nTool Call: ${toolCall.name}`);
  console.log(`Server: ${mcpTool.serverName}`);
  console.log('Arguments:');
  for (const [key, value] of Object.entries(args)) {
    console.log(`  ${key}: ${JSON.stringify(value)}`);
  }

  if (!shouldAutoExecute) {
    const { execute } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'execute',
        message: 'Execute this tool call?',
        default: false,
      },
    ]);

    if (!execute) {
      console.log('Tool call skipped');
      return JSON.stringify({ status: 'skipped', message: 'User declined to execute tool call' });
    }
  }

  try {
    console.log('\nExecuting tool...\n');
    const result = await options.mcpManager.callTool(toolCall.name, args);
    const formattedResult = formatToolResult(result);
    
    console.log(formattedResult);
    console.log('');

    return formattedResult;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.log(`Tool execution failed: ${errorMsg}`);
    return JSON.stringify({ error: errorMsg });
  }
}

function convertToolsForProvider(provider: Provider, tools: MCPTool[]): any[] {
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

async function handleCommandExecution(response: string): Promise<void> {
  const codeBlocks = detectCodeBlocks(response);

  for (const block of codeBlocks) {
    const execute = await askForExecution(block);

    if (execute) {
      console.log('\nExecuting...\n');

      const result = await executeCommand(block.code);
      console.log(formatCommandResult(result));
      console.log('');
    }
  }
}
