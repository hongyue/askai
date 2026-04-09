import { Command } from 'commander';
import { loadConfig } from './config';
import { runOneShotApp, runOpenTUIApp } from './app';
import { appVersion } from './version';

export const program = new Command();

program
  .name('askai')
  .description('A terminal AI agent that answers your questions')
  .version(appVersion);

program
  .argument('[question...]', 'Question to ask (oneshot mode)')
  .option('-p, --provider <id>', 'Override provider id')
  .option('-m, --model <name>', 'Override the selected provider model')
  .option('-c, --config <path>', 'Config file path')
  .option('-e, --execute <mode>', 'Enable automatic command execution: on or off')
  .option('--no-mcp', 'Disable MCP for this run')
  .action(async (question: string[] | undefined, options) => {
    const questionText = question && question.length > 0 ? question.join(' ') : undefined;

    try {
      const config = await loadConfig(options.config);
      let allowExecute = config.allowExecute ?? true;
      if (options.execute !== undefined) {
        if (options.execute === 'on') {
          allowExecute = true;
        } else if (options.execute === 'off') {
          allowExecute = false;
        } else {
          throw new Error('Invalid value for --execute. Use "on" or "off".');
        }
      }
      const mcpEnabled = options.mcp !== false;
      if (questionText) {
        await runOneShotApp({
          providerName: options.provider,
          modelName: options.model,
          configPath: options.config,
          allowExecute,
          mcpEnabled,
          question: questionText,
        });
      } else {
        await runOpenTUIApp({
          providerName: options.provider,
          modelName: options.model,
          configPath: options.config,
          allowExecute,
          mcpEnabled,
        });
      }
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      process.exit(1);
    }
  });
