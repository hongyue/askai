import inquirer from 'inquirer';

export interface CommandBlock {
  language: string;
  code: string;
  fullMatch: string;
}

export interface CommandResult {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  interrupted?: boolean;
}

export type ExecutionDecision = 'allow' | 'reject' | 'allow-all' | 'reject-all';

export interface ExecuteCommandOptions {
  onStart?: (proc: ReturnType<typeof Bun.spawn>) => void;
}

export function detectCodeBlocks(text: string): CommandBlock[] {
  const blocks: CommandBlock[] = [];
  const regex = /```(\w+)?\n([\s\S]*?)```/g;
  
  let match;
  while ((match = regex.exec(text)) !== null) {
    const language = match[1] || '';
    const code = match[2].trim();
    
    if (['bash', 'sh', 'shell', 'console', 'zsh'].includes(language.toLowerCase())) {
      const commands = code
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);

      for (const command of commands) {
        blocks.push({
          language,
          code: command,
          fullMatch: match[0],
        });
      }
    }
  }
  
  return blocks;
}

export function formatCommandBlock(block: CommandBlock): string {
  const lines = block.code.split('\n');
  const formatted = lines.map(line => `  │ ${line}`).join('\n');
  
  return `┌${'─'.repeat(60)}┐\n${formatted}\n└${'─'.repeat(60)}┘`;
}

export async function askForExecution(block: CommandBlock): Promise<ExecutionDecision> {
  console.log('\n' + formatCommandBlock(block));
  
  const { execute } = await inquirer.prompt([
    {
      type: 'list',
      name: 'execute',
      message: 'Execute this command?',
      choices: [
        { name: 'Allow', value: 'allow' },
        { name: 'Reject', value: 'reject' },
        { name: 'Allow all remaining', value: 'allow-all' },
        { name: 'Reject all remaining', value: 'reject-all' },
      ],
      default: 'reject',
    },
  ]);
  
  return execute;
}

export async function executeCommand(command: string, options?: ExecuteCommandOptions): Promise<CommandResult> {
  try {
    const proc = Bun.spawn(['bash', '-c', command], {
      detached: true,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    options?.onStart?.(proc);
    
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    
    return {
      command,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode,
    };
  } catch (error) {
    return {
      command,
      stdout: '',
      stderr: error instanceof Error ? error.message : 'Unknown error',
      exitCode: 1,
    };
  }
}

export function formatCommandResult(result: CommandResult): string {
  const parts: string[] = [];

  if (result.interrupted) {
    parts.push('Command interrupted');
  }
  
  if (result.stdout) {
    parts.push('Output:');
    parts.push(result.stdout);
  }
  
  if (result.stderr) {
    parts.push('Error:');
    parts.push(result.stderr);
  }
  
  if (result.exitCode !== 0) {
    parts.push(`Exit code: ${result.exitCode}`);
  } else {
    parts.push('Command completed successfully');
  }
  
  return parts.join('\n');
}
