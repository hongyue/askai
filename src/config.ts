import { mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { homedir } from 'os';

export type ProviderType = 'openai-compatible' | 'anthropic';
export type ProviderDeployment = 'hosted' | 'self-hosted';
export type ProviderKind = 'openai' | 'openrouter' | 'anthropic' | 'custom';

export interface ProviderConfig {
  kind?: ProviderKind;
  api_key?: string;
  model: string;
  models?: string[];
  base_url?: string;
}

export interface ResolvedProviderConfig extends ProviderConfig {
  id: string;
  kind: ProviderKind;
  type: ProviderType;
  deployment: ProviderDeployment;
  api_key: string;
}

export interface MCPServerConfig {
  command?: string;
  args?: string[];
  url?: string;
  autoExecute?: boolean;
}

export interface MCPConfig {
  autoExecute?: boolean;
}

export interface Config {
  provider: string;
  providers: {
    [key: string]: ProviderConfig;
  };
  system_prompt?: string;
  allowExecute?: boolean;
  mcp?: MCPConfig;
  mcpServers?: {
    [key: string]: MCPServerConfig;
  };
}

export const presetProviderIds = ['openai', 'anthropic', 'openrouter', 'ollama', 'llama.cpp', 'vllm', 'sglang'] as const;

// Normalize provider ID for case-insensitive comparison
export function normalizeProviderId(id: string): string {
  return id.trim().toLowerCase();
}

// Check if a provider ID is a preset (case-insensitive)
export function isPresetProviderId(id: string): boolean {
  const normalized = normalizeProviderId(id);
  return presetProviderIds.some(presetId => normalizeProviderId(presetId) === normalized);
}

// Find provider by case-insensitive match
export function findProviderByNormalizedId(config: Config, searchId: string): string | undefined {
  const normalizedSearch = normalizeProviderId(searchId);
  return Object.keys(config.providers).find(id => normalizeProviderId(id) === normalizedSearch);
}

// Check if provider ID is unique (case-insensitive)
export function isProviderIdUnique(config: Config, id: string, excludeId?: string): boolean {
  const normalized = normalizeProviderId(id);
  return !Object.keys(config.providers).some(existingId => {
    if (excludeId && normalizeProviderId(existingId) === normalizeProviderId(excludeId)) {
      return false;
    }
    return normalizeProviderId(existingId) === normalized;
  });
}

// Rename a provider (update config key)
export function renameProvider(config: Config, oldId: string, newId: string): void {
  const trimmedNewId = newId.trim();
  if (!trimmedNewId) {
    throw new Error('Provider ID cannot be empty');
  }

  // Validate uniqueness
  if (!isProviderIdUnique(config, trimmedNewId, oldId)) {
    throw new Error(`Provider "${trimmedNewId}" already exists`);
  }

  // Validate preset providers can't be renamed
  if (isPresetProviderId(oldId)) {
    throw new Error('Cannot rename preset providers');
  }

  // Can't rename to a preset ID
  if (isPresetProviderId(trimmedNewId)) {
    throw new Error('Cannot use preset provider ID');
  }

  // Copy provider config to new key
  config.providers[trimmedNewId] = config.providers[oldId];
  delete config.providers[oldId];

  // Update active provider if needed
  if (config.provider === oldId) {
    config.provider = trimmedNewId;
  }
}

const DEFAULT_CONFIG_PATH = join(homedir(), '.askai', 'settings.json');

const DEFAULT_SYSTEM_PROMPT = `You are a helpful terminal assistant. When suggesting shell commands, use bash code blocks. Explain what commands do before suggesting them. Be concise.`;

const legacyProviderDefaults: Record<string, { kind: ProviderKind; type: ProviderType; deployment: ProviderDeployment; base_url?: string }> = {
  openai: {
    kind: 'openai',
    type: 'openai-compatible',
    deployment: 'hosted',
    base_url: 'https://api.openai.com/v1',
  },
  openrouter: {
    kind: 'openrouter',
    type: 'openai-compatible',
    deployment: 'hosted',
    base_url: 'https://openrouter.ai/api/v1',
  },
  anthropic: {
    kind: 'anthropic',
    type: 'anthropic',
    deployment: 'hosted',
    base_url: 'https://api.anthropic.com',
  },
};

export async function loadConfig(configPath?: string): Promise<Config> {
  const path = configPath || DEFAULT_CONFIG_PATH;

  try {
    const file = Bun.file(path);
    if (!(await file.exists())) {
      throw new Error(
        `Settings file not found: ${path}\n` +
        `Provide a settings file at this path, copy the bundled template, or use --config <path>.`
      );
    }

    const config = await file.json();
    return validateConfig(config);
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to load config: ${error.message}`);
    }
    throw error;
  }
}

export async function saveConfig(config: Config, configPath?: string): Promise<void> {
  const path = resolveConfigPath(configPath);
  const validated = validateConfig(config);

  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(validated, null, 2)}\n`);
}

export function resolveConfigPath(configPath?: string): string {
  return configPath || DEFAULT_CONFIG_PATH;
}

export function listProviderIds(config: Config): string[] {
  return Object.keys(config.providers);
}

export function listResolvedProviders(config: Config): ResolvedProviderConfig[] {
  return listProviderIds(config).map(providerId => resolveProviderConfig(config, providerId));
}

export function resolveProviderConfig(config: Config, providerId?: string): ResolvedProviderConfig {
  const id = providerId || config.provider;
  const providerConfig = config.providers[id];

  if (!providerConfig) {
    throw new Error(`Provider "${id}" is not configured`);
  }

  const inferredDefaults = inferProviderDefaults(id, providerConfig);
  const kind = providerConfig.kind || inferredDefaults.kind;
  const type = inferredDefaults.type;
  const deployment = inferredDefaults.deployment;

  if (type === 'anthropic') {
    if (!providerConfig.api_key || typeof providerConfig.api_key !== 'string') {
      throw new Error(`Provider "${id}" is missing api_key`);
    }
    if (!providerConfig.model || typeof providerConfig.model !== 'string') {
      throw new Error(`Provider "${id}" is missing model`);
    }
    return {
      ...providerConfig,
      id,
      kind,
      type,
      deployment,
      api_key: providerConfig.api_key,
      base_url: providerConfig.base_url || inferredDefaults.base_url,
    };
  }

  if (!providerConfig.model || typeof providerConfig.model !== 'string') {
    throw new Error(`Provider "${id}" is missing model`);
  }

  const baseUrl = providerConfig.base_url || inferredDefaults.base_url;
  if (!baseUrl || typeof baseUrl !== 'string') {
    throw new Error(`Provider "${id}" is missing base_url`);
  }

  let apiKey = providerConfig.api_key;
  if ((!apiKey || typeof apiKey !== 'string') && deployment === 'hosted') {
    throw new Error(`Provider "${id}" is missing api_key`);
  }

  if (!apiKey || typeof apiKey !== 'string') {
    apiKey = '';
  }

  return {
    ...providerConfig,
    id,
    kind,
    type,
    deployment,
    api_key: apiKey,
    base_url: baseUrl,
  };
}

export function createProviderConfig(
  providerId: string,
  input: ProviderConfig,
): ProviderConfig {
  const inferredDefaults = inferProviderDefaults(providerId, input);
  const normalizedModels = normalizeModels(input.models, input.model);

  return {
    kind: input.kind || inferredDefaults.kind,
    api_key: typeof input.api_key === 'string' ? input.api_key : undefined,
    base_url: input.base_url?.trim() || inferredDefaults.base_url,
    model: input.model.trim(),
    models: normalizedModels.length > 0 ? normalizedModels : undefined,
  };
}

export function setProviderModel(config: Config, providerId: string, model: string): void {
  const provider = config.providers[providerId];
  if (!provider) {
    throw new Error(`Provider "${providerId}" is not configured`);
  }

  const trimmedModel = model.trim();
  if (!trimmedModel) {
    throw new Error('Model name cannot be empty');
  }

  provider.model = trimmedModel;
  provider.models = mergeModels(provider.models, trimmedModel);
}

export function removeProviderModel(config: Config, providerId: string, model: string): string | null {
  const provider = config.providers[providerId];
  if (!provider) {
    throw new Error(`Provider "${providerId}" is not configured`);
  }

  const trimmedModel = model.trim();
  if (!trimmedModel) {
    throw new Error('Model name cannot be empty');
  }

  const remainingModels = (provider.models || [])
    .map(item => item.trim())
    .filter(item => item && item !== trimmedModel);

  if (provider.model === trimmedModel) {
    if (remainingModels.length === 0) {
      throw new Error('Cannot delete the only saved model for this provider');
    }
    provider.model = remainingModels[0];
  }

  provider.models = normalizeModels(remainingModels, provider.model);
  return provider.model === trimmedModel ? null : provider.model;
}

export function upsertProvider(config: Config, providerId: string, providerConfig: ProviderConfig): void {
  const trimmedId = providerId.trim();
  if (!trimmedId) {
    throw new Error('Provider id cannot be empty');
  }

  config.providers[trimmedId] = createProviderConfig(trimmedId, providerConfig);
}

export function setActiveProvider(config: Config, providerId: string): void {
  if (!config.providers[providerId]) {
    throw new Error(`Provider "${providerId}" is not configured`);
  }
  config.provider = providerId;
}

export function getProviderLabel(provider: ResolvedProviderConfig): string {
  return provider.id;
}

export function normalizeModelList(value: string): string[] {
  return normalizeModels(
    value
      .split(',')
      .map(item => item.trim())
      .filter(Boolean),
  );
}

function validateConfig(config: unknown): Config {
  if (!config || typeof config !== 'object') {
    throw new Error('Invalid config: must be an object');
  }

  const cfg = config as Record<string, unknown>;

  if (!cfg.provider || typeof cfg.provider !== 'string') {
    throw new Error('Invalid config: missing or invalid "provider" field');
  }

  if (!cfg.providers || typeof cfg.providers !== 'object') {
    throw new Error('Invalid config: missing or invalid "providers" field');
  }

  const providersInput = cfg.providers as Record<string, unknown>;
  const sourceProviders: Record<string, ProviderConfig> = {};

  for (const [providerId, providerConfigValue] of Object.entries(providersInput)) {
    if (!providerConfigValue || typeof providerConfigValue !== 'object') {
      throw new Error(`Invalid config: provider "${providerId}" must be an object`);
    }

    const providerConfig = providerConfigValue as Record<string, unknown>;
    if (!providerConfig.model || typeof providerConfig.model !== 'string') {
      throw new Error(`Invalid config: provider "${providerId}" missing model`);
    }

    sourceProviders[providerId] = createProviderConfig(providerId, {
      kind: providerConfig.kind as ProviderKind | undefined,
      api_key: providerConfig.api_key as string | undefined,
      model: providerConfig.model,
      models: Array.isArray(providerConfig.models)
        ? providerConfig.models.filter((model): model is string => typeof model === 'string')
        : undefined,
      base_url: providerConfig.base_url as string | undefined,
    });
  }
  const { providers, activeProviderId } = normalizeProviders(sourceProviders, cfg.provider as string);

  if (!providers[activeProviderId]) {
    throw new Error(`Invalid config: provider "${cfg.provider}" not found in providers`);
  }

  const normalizedConfig: Config = {
    provider: activeProviderId,
    providers,
    system_prompt: (cfg.system_prompt as string) || DEFAULT_SYSTEM_PROMPT,
    allowExecute: typeof cfg.allowExecute === 'boolean' ? cfg.allowExecute : undefined,
    mcp: cfg.mcp as Config['mcp'],
    mcpServers: cfg.mcpServers as Config['mcpServers'],
  };

  for (const providerId of Object.keys(providers)) {
    resolveProviderConfig(normalizedConfig, providerId);
  }

  return normalizedConfig;
}

function normalizeProviders(sourceProviders: Record<string, ProviderConfig>, requestedActiveProviderId: string): {
  providers: Config['providers'];
  activeProviderId: string;
} {
  const providers: Config['providers'] = {};
  const sourceToCanonical = new Map<string, string>();

  // First pass: match preset providers (case-insensitive)
  for (const presetId of presetProviderIds) {
    const sourceId = findPresetSourceProviderId(sourceProviders, presetId);
    if (!sourceId) {
      continue;
    }

    // Preserve the original case from the source config
    providers[sourceId] = createProviderConfig(sourceId, sourceProviders[sourceId]);
    sourceToCanonical.set(sourceId, sourceId);
    sourceToCanonical.set(presetId, sourceId); // Map lowercase preset ID to actual source ID
  }

  // Second pass: add all other providers as-is (custom providers)
  for (const [sourceId, sourceConfig] of Object.entries(sourceProviders)) {
    if (sourceToCanonical.has(sourceId)) {
      continue; // Already matched as preset
    }

    // Keep the original ID for custom providers
    providers[sourceId] = createProviderConfig(sourceId, sourceConfig);
    sourceToCanonical.set(sourceId, sourceId);
  }

  const requestedCanonicalId = sourceToCanonical.get(requestedActiveProviderId) || requestedActiveProviderId;
  const activeProviderId = providers[requestedCanonicalId]
    ? requestedCanonicalId
    : Object.keys(providers)[0];

  if (!activeProviderId) {
    throw new Error('Invalid config: no supported providers configured');
  }

  return { providers, activeProviderId };
}

function findPresetSourceProviderId(sourceProviders: Record<string, ProviderConfig>, presetId: typeof presetProviderIds[number]): string | undefined {
  // Case-insensitive exact match
  const normalizedPresetId = presetId.toLowerCase();
  for (const sourceId of Object.keys(sourceProviders)) {
    if (sourceId.toLowerCase() === normalizedPresetId) {
      return sourceId;
    }
  }

  // Fallback: match by kind
  return Object.keys(sourceProviders).find(sourceId => {
    const sourceConfig = sourceProviders[sourceId];
    return sourceConfig.kind === presetId;
  });
}

function inferProviderDefaults(providerId: string, providerConfig: ProviderConfig): {
  kind: ProviderKind;
  type: ProviderType;
  deployment: ProviderDeployment;
  base_url?: string;
} {
  if (providerConfig.kind) {
    switch (providerConfig.kind) {
      case 'openai':
        return legacyProviderDefaults.openai;
      case 'openrouter':
        return legacyProviderDefaults.openrouter;
      case 'anthropic':
        return legacyProviderDefaults.anthropic;
      case 'custom':
      default:
        return {
          kind: 'custom',
          type: 'openai-compatible',
          deployment: providerConfig.base_url ? 'self-hosted' : 'hosted',
          base_url: providerConfig.base_url,
        };
    }
  }

  const legacyDefaults = legacyProviderDefaults[providerId];
  if (legacyDefaults) {
    return legacyDefaults;
  }

  return {
    kind: 'custom',
    type: 'openai-compatible',
    deployment: providerConfig.base_url ? 'self-hosted' : 'hosted',
    base_url: providerConfig.base_url,
  };
}

function inferKindFromProviderId(providerId: string, baseUrl?: string): ProviderKind {
  if (providerId === 'openai' || baseUrl === 'https://api.openai.com/v1') {
    return 'openai';
  }
  if (providerId === 'openrouter' || baseUrl === 'https://openrouter.ai/api/v1') {
    return 'openrouter';
  }
  if (providerId === 'anthropic' || baseUrl === 'https://api.anthropic.com') {
    return 'anthropic';
  }
  return 'custom';
}

function normalizeModels(models?: string[], currentModel?: string): string[] {
  const deduped = new Set<string>();

  if (currentModel && currentModel.trim()) {
    deduped.add(currentModel.trim());
  }

  for (const model of models || []) {
    const trimmedModel = model.trim();
    if (trimmedModel) {
      deduped.add(trimmedModel);
    }
  }

  return Array.from(deduped);
}

function mergeModels(models: string[] | undefined, currentModel: string): string[] {
  return normalizeModels(models, currentModel);
}
