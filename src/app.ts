import { loadConfig } from './config';
import { createProviderFromConfig } from './chat';
import { oneshot, interactive } from './chat';
import { MCPManager } from './mcp';

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

  if (options.mcpEnabled && config.mcpServers && Object.keys(config.mcpServers).length > 0) {
    mcpManager = new MCPManager(config);
    await mcpManager.connectAll();
  }

  const provider = await createProviderFromConfig(config);
  const systemPrompt = config.system_prompt || 'You are a helpful terminal assistant.';

  if (options.question) {
    await oneshot(
      {
        provider,
        systemPrompt,
        allowExecute: options.allowExecute,
        mcpManager,
      },
      options.question
    );
  } else {
    await interactive({
      provider,
      systemPrompt,
      allowExecute: options.allowExecute,
      mcpManager,
    });
  }
}
