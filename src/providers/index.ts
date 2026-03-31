import type { ResolvedProviderConfig } from '../config';
import type { Provider } from './base';
import { OpenAIProvider } from './openai';
import { AnthropicProvider } from './anthropic';

export type { Provider, Message, StreamChunk } from './base';
export { OpenAIProvider } from './openai';
export { AnthropicProvider } from './anthropic';

export async function createProviderFromConfig(config: ResolvedProviderConfig): Promise<Provider> {
  switch (config.type) {
    case 'openai-compatible':
      return new OpenAIProvider(config, config.id, config.display_name);
    case 'anthropic':
      return new AnthropicProvider(config, config.id, config.display_name);
    default:
      throw new Error(`Unknown provider type: ${String(config.type)}`);
  }
}
