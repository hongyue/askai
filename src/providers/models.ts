import OpenAI from 'openai';
import type { ResolvedProviderConfig } from '../config';

export async function fetchAvailableModels(config: ResolvedProviderConfig): Promise<string[]> {
  switch (config.type) {
    case 'openai-compatible':
      return fetchOpenAICompatibleModels(config);
    case 'anthropic-compatible':
      return fetchAnthropicModels(config);
    default:
      return [];
  }
}

function normalizeModelIds(ids: string[]): string[] {
  return Array.from(new Set(ids.map(id => id.trim()).filter(Boolean))).sort();
}

async function fetchOpenAICompatibleModels(config: ResolvedProviderConfig): Promise<string[]> {
  const client = new OpenAI({
    apiKey: config.api_key,
    baseURL: config.base_url || 'https://api.openai.com/v1',
  });

  const page = await client.models.list();
  return normalizeModelIds((page.data || []).map(model => model.id));
}

async function fetchAnthropicModels(config: ResolvedProviderConfig): Promise<string[]> {
  const baseUrl = (config.base_url || 'https://api.anthropic.com').replace(/\/$/, '');
  const response = await fetch(`${baseUrl}/v1/models`, {
    headers: {
      'x-api-key': config.api_key,
      'anthropic-version': '2023-06-01',
    },
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Anthropic models API error: ${response.status} ${message}`.trim());
  }

  const payload = await response.json() as {
    data?: Array<{
      id?: string;
      display_name?: string;
    }>;
  };

  return normalizeModelIds((payload.data || []).map(model => model.id || model.display_name || ''));
}
