import { Command } from 'commander';
import { createDefaultConfig } from './config';
import { runApp } from './app';

export const program = new Command();

program
  .name('askai')
  .description('A terminal AI agent that answers your questions')
  .version('0.1.0');

program
  .arguments('[question...]', 'Question to ask (oneshot mode)')
  .option('-p, --provider <name>', 'Override provider')
  .option('-m, --model <name>', 'Override model')
  .option('-c, --config <path>', 'Config file path')
  .option('--no-execute', 'Disable shell command execution')
  .option('--no-mcp', 'Disable MCP servers')
  .option('--init', 'Create a default config file')
  .option('--tui', 'Use OpenTUI interface (fixed prompt at bottom)')
  .action(async (question: string[] | undefined, options) => {
    if (options.init) {
      try {
        await createDefaultConfig(options.config);
        console.log('Config file created successfully!');
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
        process.exit(1);
      }
      return;
    }

    const questionText = question && question.length > 0 ? question.join(' ') : undefined;

    // Use OpenTUI if requested and TTY available
    if (options.tui && process.stdin.isTTY) {
      try {
        const { runOpenTUIApp } = await import('./opentui-app');
        await runOpenTUIApp({
          providerName: options.provider,
          modelName: options.model,
          configPath: options.config,
          allowExecute: options.execute !== false,
          mcpEnabled: options.mcp !== false,
        });
        return;
      } catch (error) {
        console.error(`OpenTUI failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        console.log('Falling back to readline mode...\n');
      }
    }

    // Default readline mode
    try {
      await runApp({
        providerName: options.provider,
        modelName: options.model,
        configPath: options.config,
        allowExecute: options.execute !== false,
        mcpEnabled: options.mcp !== false,
        question: questionText,
      });
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      process.exit(1);
    }
  });
