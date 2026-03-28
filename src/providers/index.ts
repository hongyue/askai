import type { Config } from '../config';
import type { Provider } from './base';
import { OpenAIProvider } from './openai';
import { AnthropicProvider } from './anthropic';

export type { Provider, Message, StreamChunk } from './base';
export { OpenAIProvider } from './openai';
export { AnthropicProvider } from './anthropic';

export async function createProviderFromConfig(config: Config): Promise<Provider> {
  const providerConfig = config.providers[config.provider];

  switch (config.provider) {
    case 'openai':
    case 'llama':
    case 'ollama':
      return new OpenAIProvider(providerConfig, config.provider);
    case 'anthropic':
      return new AnthropicProvider(providerConfig, config.provider);
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}
