import { loadConfig, resolveConfigPath, findProviderByNormalizedId, setActiveProvider, setProviderModel, resolveProviderConfig, saveConfig, getProviderLabel, presetProviderIds, type ResolvedProviderConfig, type ProviderType } from './config';
import { MCPManager, type MCPServerState } from './mcp';
import { createProviderFromConfig } from './providers';
import { fetchAvailableModels } from './providers/models';
import { convertToOpenAITools, convertToAnthropicTools } from './mcp/tools';
import { createInitialState } from './commands';
import { type ChatOptions, type Message, type TokenUsage } from './providers/base';
import { type MCPTool } from './mcp/client';
import { createEmptySession } from './input-utils';
import { getSession, getMessages, type SessionStorage } from './session';

export async function getAssistantResponse(
  provider: Awaited<ReturnType<typeof import('./providers').createProviderFromConfig>>,
  messages: Message[],
  providerTools: any[],
  options?: ChatOptions,
): Promise<Message> {
  if (providerTools.length > 0) {
    return await provider.chatComplete(messages, providerTools, options);
  }

  let fullResponse = '';
  let usage: TokenUsage | undefined;
  for await (const chunk of provider.chat(messages, providerTools, options)) {
    if (chunk.content) fullResponse += chunk.content;
    if (chunk.usage) {
      usage = chunk.usage;
    }
    if (chunk.done) {
      return {
        role: 'assistant',
        content: fullResponse,
        tool_calls: chunk.tool_calls,
        usage,
      };
    }
  }

  return {
    role: 'assistant',
    content: fullResponse,
    usage,
  };
}

export interface RunAppOptions {
  configPath?: string;
  providerName?: string;
  modelName?: string;
  allowExecute?: boolean;
  mcpEnabled?: boolean;
}

export async function initializeRuntime(options: RunAppOptions): Promise<{
  config: Awaited<ReturnType<typeof loadConfig>>;
  configPath: string;
  mcpManager: MCPManager | undefined;
  getProvider: () => Awaited<ReturnType<typeof createProviderFromConfig>>;
  getResolvedProvider: () => ResolvedProviderConfig;
  systemPrompt: string;
  state: ReturnType<typeof createInitialState>;
  getProviderTools: () => any[];
  refreshProviderTools: () => Promise<void>;
  switchProvider: (providerId: string, persist?: boolean) => Promise<Awaited<ReturnType<typeof createProviderFromConfig>>>;
  switchModel: (model: string, persist?: boolean) => Promise<Awaited<ReturnType<typeof createProviderFromConfig>>>;
  persistConfig: () => Promise<void>;
  getMcpServerStates: () => MCPServerState[];
  messages: Message[];
  session: SessionStorage;
  startNewSession: () => SessionStorage;
  loadPersistedSession: (id: string) => void;
}> {
  const configPath = resolveConfigPath(options.configPath);
  const config = await loadConfig(configPath);
  if (options.providerName) {
    const providerId = findProviderByNormalizedId(config, options.providerName);
    if (!providerId) {
      throw new Error(`Provider "${options.providerName}" not found`);
    }
    setActiveProvider(config, providerId);
  }
  if (options.modelName) {
    setProviderModel(config, config.provider, options.modelName);
  }

  let mcpManager: MCPManager | undefined;
  let mcpTools: MCPTool[] = [];

  if (options.mcpEnabled && config.mcpServers && Object.keys(config.mcpServers).length > 0) {
    mcpManager = new MCPManager(config);
    await mcpManager.connectAutoConnect();
    mcpTools = await mcpManager.listAllTools();
  }

  let resolvedProvider = resolveProviderConfig(config);
  let provider = await createProviderFromConfig(resolvedProvider);
  const systemPrompt = config.system_prompt || 'You are a helpful terminal assistant.';
  const state = createInitialState(options.allowExecute ?? false);

  function convertTools(providerType: ProviderType, tools: MCPTool[]): any[] {
    if (tools.length === 0) return [];
    switch (providerType) {
      case 'openai-compatible':
        return convertToOpenAITools(tools);
      case 'anthropic':
        return convertToAnthropicTools(tools);
      default:
        return [];
    }
  }

  let providerTools = convertTools(resolvedProvider.type, mcpTools);
  const refreshProviderTools = async () => {
    if (mcpManager) {
      await mcpManager.refreshTools();
      mcpTools = await mcpManager.listAllTools();
    } else {
      mcpTools = [];
    }
    providerTools = convertTools(resolvedProvider.type, mcpTools);
  };

  const persistConfig = async () => {
    await saveConfig(config, configPath);
  };

  const rebuildProvider = async (persist: boolean) => {
    resolvedProvider = resolveProviderConfig(config);
    provider = await createProviderFromConfig(resolvedProvider);
    await refreshProviderTools();
    if (persist) {
      await persistConfig();
    }
    return provider;
  };

  const switchProvider = async (providerId: string, persist = true) => {
    setActiveProvider(config, providerId);
    return rebuildProvider(persist);
  };

  const switchModel = async (model: string, persist = true) => {
    setProviderModel(config, config.provider, model);
    return rebuildProvider(persist);
  };

  const messages: Message[] = [{ role: 'system', content: systemPrompt }];

  let session: SessionStorage = createEmptySession(resolvedProvider.id, resolvedProvider.model);

  const startNewSession = (): SessionStorage => {
    messages.length = 0;
    messages.push({ role: 'system', content: systemPrompt });
    session = createEmptySession(resolvedProvider.id, resolvedProvider.model);
    return session;
  };

  const loadPersistedSession = (id: string): void => {
    const stored = getSession(id);
    if (!stored) throw new Error(`Session "${id}" not found`);
    const loaded = getMessages(id);
    messages.length = 0;
    messages.push(...loaded);
    session = stored;
  };

  return {
    config,
    configPath,
    mcpManager,
    getProvider: () => provider,
    getResolvedProvider: () => resolvedProvider,
    systemPrompt,
    state,
    getProviderTools: () => providerTools,
    refreshProviderTools,
    switchProvider,
    switchModel,
    persistConfig,
    getMcpServerStates: () => mcpManager ? mcpManager.listServerStates() : [],
    messages,
    session,
    startNewSession,
    loadPersistedSession,
  };
}

export function formatToolContent(content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>): string {
  return content
    .map(item => {
      if (item.type === 'text' && item.text) {
        return item.text;
      }
      if (item.data) {
        return item.data;
      }
      return `[${item.type}${item.mimeType ? `: ${item.mimeType}` : ''}]`;
    })
    .join('\n')
    .trim();
}

export function getProviderSummary(provider: ResolvedProviderConfig): string {
  return `${getProviderLabel(provider)} • ${provider.type} • ${provider.model}`;
}
