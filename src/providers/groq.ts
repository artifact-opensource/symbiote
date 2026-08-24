// Symbiote — Groq provider (OpenAI-compatible, free tier)
// Models: llama-3.3-70b-versatile, qwen/qwen3-32b, openai/gpt-oss-120b
// Speed: 280-1000 tok/sec on Groq's LPU hardware
// Rate limit handling: auto-retry on 429 with server-specified delay

import type { Message, ToolDef, ProviderConfig, StreamEvent, Provider } from './types.js';
import { openaiProvider } from './openai.js';

const DEFAULT_BASE_URL = 'https://api.groq.com/openai';
const MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 15_000; // 15s default if server doesn't specify

function parseRetryDelay(errorMessage: string): number {
  // Groq error: "Please try again in 10.79s"
  const match = errorMessage.match(/try again in ([\d.]+)s/i);
  if (match) {
    return Math.ceil(parseFloat(match[1]) * 1000) + 500; // Add 500ms buffer
  }
  return DEFAULT_RETRY_DELAY_MS;
}

function is429Error(err: unknown): boolean {
  if (err instanceof Error) {
    return err.message.includes('429') || err.message.includes('rate_limit');
  }
  return false;
}

async function* streamGroq(
  messages: Message[],
  tools: ToolDef[],
  config: ProviderConfig,
): AsyncIterable<StreamEvent> {
  const groqConfig: ProviderConfig = {
    ...config,
    baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
    apiKey: config.apiKey ?? process.env.GROQ_API_KEY ?? '',
  };

  if (!groqConfig.apiKey) {
    throw new Error('Groq API key not configured. Set GROQ_API_KEY env var or providers.groq.apiKey in config.');
  }

  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      yield* openaiProvider.stream(messages, tools, groqConfig);
      return; // Success — exit
    } catch (err) {
      lastError = err;

      if (is429Error(err) && attempt < MAX_RETRIES) {
        const delayMs = parseRetryDelay(err instanceof Error ? err.message : '');
        console.log(`  [groq] Rate limited (attempt ${attempt + 1}/${MAX_RETRIES + 1}). Retrying in ${(delayMs / 1000).toFixed(1)}s...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      }

      throw err; // Non-429 error or max retries exhausted
    }
  }

  throw lastError;
}

export const groqProvider: Provider = {
  name: 'groq',
  stream: streamGroq,
};
