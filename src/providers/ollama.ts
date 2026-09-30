// Symbiote — Ollama local provider (OpenAI-compat API, localhost:11434)
// Local fallback — runs entirely on local hardware, no cloud dependency

import type { Message, ToolDef, ProviderConfig, StreamEvent, Provider } from './types.js';
import { openaiProvider } from './openai.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';

async function* streamOllama(
  messages: Message[],
  tools: ToolDef[],
  config: ProviderConfig,
): AsyncIterable<StreamEvent> {
  const ollamaConfig: ProviderConfig = {
    ...config,
    baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
    apiKey: config.apiKey ?? 'ollama', // Ollama doesn't need auth but OpenAI provider expects a key
  };

  yield* openaiProvider.stream(messages, tools, ollamaConfig);
}

export const ollamaProvider: Provider = {
  name: 'ollama',
  stream: streamOllama,
};
