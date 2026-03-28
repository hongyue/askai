import { Command } from 'commander';
import { createDefaultConfig, loadConfig } from './config';
import { runOpenTUIApp } from './opentui-app';

export const program = new Command();

program
  .name('askai')
  .description('A terminal AI agent that answers your questions')
  .version('0.1.0');

program
  .argument('[question...]', 'Question to ask (oneshot mode)')
  .option('-p, --provider <name>', 'Override provider')
  .option('-m, --model <name>', 'Override model')
  .option('-c, --config <path>', 'Config file path')
  .option('--execute <mode>', 'Set shell command execution: on or off')
  .option('--mcp <mode>', 'Set MCP servers: on or off')
  .option('--init', 'Create a default config file')
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
      let mcpEnabled = true;
      if (options.mcp !== undefined) {
        if (options.mcp === 'on') {
          mcpEnabled = true;
        } else if (options.mcp === 'off') {
          mcpEnabled = false;
        } else {
          throw new Error('Invalid value for --mcp. Use "on" or "off".');
        }
      }
      await runOpenTUIApp({
        providerName: options.provider,
        modelName: options.model,
        configPath: options.config,
        allowExecute,
        mcpEnabled,
        question: questionText,
      });
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      process.exit(1);
    }
  });
