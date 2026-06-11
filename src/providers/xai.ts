// Symbiote — xAI (Grok) provider (OpenAI-compatible)
// Models: grok-3, grok-3-fast, grok-3-mini, grok-3-mini-fast
// grok-3: strongest reasoning, grok-3-fast: lower latency
// grok-3-mini: lightweight reasoning with think mode
// API: https://api.x.ai/v1 (OpenAI-compatible)

import type { Message, ToolDef, ProviderConfig, StreamEvent, Provider } from './types.js';
import { openaiProvider } from './openai.js';

const DEFAULT_BASE_URL = 'https://api.x.ai/v1';
const MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 10_000;

function parseRetryDelay(errorMessage: string): number {
  const match = errorMessage.match(/try again in ([\d.]+)s/i);
  if (match) {
    return Math.ceil(parseFloat(match[1]) * 1000) + 500;
  }
  return DEFAULT_RETRY_DELAY_MS;
}

function is429Error(err: unknown): boolean {
  if (err instanceof Error) {
    return err.message.includes('429') || err.message.includes('rate_limit');
  }
  return false;
}

async function* streamXai(
  messages: Message[],
  tools: ToolDef[],
  config: ProviderConfig,
): AsyncIterable<StreamEvent> {
  const xaiConfig: ProviderConfig = {
    ...config,
    baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
    apiKey: config.apiKey ?? process.env.XAI_API_KEY ?? '',
  };

  if (!xaiConfig.apiKey) {
    throw new Error('xAI API key not configured. Set XAI_API_KEY env var or providers.xai.apiKey in config.');
  }

  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      yield* openaiProvider.stream(messages, tools, xaiConfig);
      return;
    } catch (err) {
      lastError = err;

      if (is429Error(err) && attempt < MAX_RETRIES) {
        const delayMs = parseRetryDelay(err instanceof Error ? err.message : '');
        console.log(`  [xai] Rate limited (attempt ${attempt + 1}/${MAX_RETRIES + 1}). Retrying in ${(delayMs / 1000).toFixed(1)}s...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      }

      throw err;
    }
  }

  throw lastError;
}

export const xaiProvider: Provider = {
  name: 'xai',
  stream: streamXai,
};
