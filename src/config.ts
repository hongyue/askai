import { join } from 'path';
import { homedir } from 'os';

export interface ProviderConfig {
  api_key: string;
  model: string;
  base_url?: string;
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
  mcp?: MCPConfig;
  mcpServers?: {
    [key: string]: MCPServerConfig;
  };
}

const DEFAULT_CONFIG_PATH = join(homedir(), '.askai', 'config.json');

const DEFAULT_SYSTEM_PROMPT = `You are a helpful terminal assistant. When suggesting shell commands, use bash code blocks. Explain what commands do before suggesting them. Be concise.`;

export async function loadConfig(configPath?: string): Promise<Config> {
  const path = configPath || DEFAULT_CONFIG_PATH;
  
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) {
      throw new Error(`Config file not found: ${path}\nRun 'askai init' to create a default config.`);
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
  
  const providers = cfg.providers as Record<string, unknown>;
  if (!providers[cfg.provider]) {
    throw new Error(`Invalid config: provider "${cfg.provider}" not found in providers`);
  }
  
  const providerConfig = providers[cfg.provider] as Record<string, unknown>;
  if (!providerConfig.api_key || typeof providerConfig.api_key !== 'string') {
    throw new Error(`Invalid config: provider "${cfg.provider}" missing api_key`);
  }
  
  if (!providerConfig.model || typeof providerConfig.model !== 'string') {
    throw new Error(`Invalid config: provider "${cfg.provider}" missing model`);
  }
  
  return {
    provider: cfg.provider as string,
    providers: cfg.providers as Config['providers'],
    system_prompt: (cfg.system_prompt as string) || DEFAULT_SYSTEM_PROMPT,
    mcp: cfg.mcp as Config['mcp'],
    mcpServers: cfg.mcpServers as Config['mcpServers'],
  };
}

export async function createDefaultConfig(configPath?: string): Promise<void> {
  const path = configPath || DEFAULT_CONFIG_PATH;
  const dir = path.substring(0, path.lastIndexOf('/'));
  
  // Create directory if it doesn't exist
  await Bun.write(join(dir, '.keep'), '');
  
  const defaultConfig: Config = {
    provider: 'llama',
    providers: {
      llama: {
        api_key: 'llama',
        model: 'Qwen3.5-35B-A3B-Q4_K_M',
        base_url: 'http://172.17.0.21:8080/v1'
      }
    },
    mcp: {
      autoExecute: false
    }
  };
  
  await Bun.write(path, JSON.stringify(defaultConfig, null, 2));
}
