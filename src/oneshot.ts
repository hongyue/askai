import { detectCodeBlocks, askForExecution, executeCommand as executeShellCommand, formatCommandResult, type CommandBlock, type ExecutionDecision } from './shell';
import { createSession, addMessage, autoGenerateTitle, recordSessionUsage } from './session';
import { initializeRuntime, formatToolContent, getProviderSummary, getAssistantResponse, type RunAppOptions } from './app-runtime';
import { getRandomOneShotFeedbackPrompt, oneShotFeedbackColor, ansiReset, calculateTokenSpeed } from './input-utils';
import { type Message } from './providers/base';

export interface OneShotOptions extends RunAppOptions {
  question: string;
}

interface PendingExecution {
  blocks: CommandBlock[];
  index: number;
  mode: 'ask' | 'allow-all' | 'reject-all';
}

async function runDetectedCommandBlocks(response: string): Promise<void> {
  const blocks = detectCodeBlocks(response);
  let mode: PendingExecution['mode'] = 'ask';
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    let decision: ExecutionDecision;
    if (mode === 'allow-all') {
      decision = 'allow';
    } else {
      decision = await askForExecution(block);
    }

    if (decision === 'allow-all') {
      mode = 'allow-all';
      const remainingCount = blocks.length - index;
      console.log(`Executing ${remainingCount} command${remainingCount === 1 ? '' : 's'}.`);
      decision = 'allow';
    } else if (decision === 'reject-all') {
      const remainingCount = blocks.length - index;
      console.log(`Skipped ${remainingCount} command${remainingCount === 1 ? '' : 's'}.`);
      return;
    }

    if (decision !== 'allow') {
      console.log('Skipped command execution.');
      continue;
    }

    const result = await executeShellCommand(block.code);
    console.log(formatCommandResult(result));
  }
}

export async function runOneShotApp(options: OneShotOptions): Promise<void> {
  const runtime = await initializeRuntime(options);
  const { state, mcpManager, messages } = runtime;
  const provider = runtime.getProvider();
  let providerTools = runtime.getProviderTools();

  const title = autoGenerateTitle(options.question);
  let session = createSession(title, runtime.getResolvedProvider().id, runtime.getResolvedProvider().model);
  addMessage(session.id, 'system', runtime.systemPrompt);

  messages.push({ role: 'user', content: options.question });
  addMessage(session.id, 'user', options.question);

  try {
    while (true) {
      console.log(`${oneShotFeedbackColor}${getRandomOneShotFeedbackPrompt()}${ansiReset}`);
      const responseStartedAt = Date.now();
      const response = await getAssistantResponse(provider, messages, providerTools);
      const tokenSpeed = calculateTokenSpeed(response.usage, responseStartedAt);
      if (session.id) {
        const updatedSession = recordSessionUsage(session.id, response.usage, tokenSpeed);
        if (updatedSession) {
          session = updatedSession;
        }
      }
      if (tokenSpeed !== undefined) {
        response.tokenSpeed = tokenSpeed;
      }

      if (response.content) {
        console.log(response.content);
      }

      messages.push(response);
      addMessage(session.id, 'assistant', response.content, response.tool_calls);

      if (response.tool_calls && response.tool_calls.length > 0 && mcpManager) {
        for (const toolCall of response.tool_calls) {
          const args = toolCall.arguments ? JSON.parse(toolCall.arguments) as Record<string, unknown> : {};
          const result = await mcpManager.callTool(toolCall.name, args);
          const content = formatToolContent(result.content);
          messages.push({
            role: 'tool',
            content: content || (result.isError ? 'Tool returned an error.' : 'Tool completed successfully.'),
            tool_call_id: toolCall.id,
          });
          addMessage(session.id, 'tool', content || (result.isError ? 'Tool returned an error.' : 'Tool completed successfully.'), undefined, toolCall.id);
        }
        continue;
      }

      if (state.allowExecute && response.content) {
        await runDetectedCommandBlocks(response.content);
      }
      break;
    }
  } finally {
    if (mcpManager) {
      await mcpManager.disconnectAll();
    }
  }
}
