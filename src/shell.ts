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
}

export function detectCodeBlocks(text: string): CommandBlock[] {
  const blocks: CommandBlock[] = [];
  const regex = /```(\w+)?\n([\s\S]*?)```/g;
  
  let match;
  while ((match = regex.exec(text)) !== null) {
    const language = match[1] || '';
    const code = match[2].trim();
    
    if (['bash', 'sh', 'shell', 'console', 'zsh'].includes(language.toLowerCase())) {
      blocks.push({
        language,
        code,
        fullMatch: match[0],
      });
    }
  }
  
  return blocks;
}

export function formatCommandBlock(block: CommandBlock): string {
  const lines = block.code.split('\n');
  const formatted = lines.map(line => `  │ ${line}`).join('\n');
  
  return `┌${'─'.repeat(60)}┐\n${formatted}\n└${'─'.repeat(60)}┘`;
}

export async function askForExecution(block: CommandBlock): Promise<boolean> {
  console.log('\n' + formatCommandBlock(block));
  
  const { execute } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'execute',
      message: 'Execute this command?',
      default: false,
    },
  ]);
  
  return execute;
}

export async function executeCommand(command: string): Promise<CommandResult> {
  try {
    const proc = Bun.spawn(['bash', '-c', command], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    
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
