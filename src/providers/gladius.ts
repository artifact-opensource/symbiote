// Symbiote — GLADIUS local provider (localhost:8741, OpenAI-compat API)

import type { Message, ToolDef, ProviderConfig, StreamEvent, Provider } from './types.js';
import { openaiProvider } from './openai.js';

const DEFAULT_BASE_URL = 'http://localhost:8741';

async function* streamGladius(
  messages: Message[],
  tools: ToolDef[],
  config: ProviderConfig,
): AsyncIterable<StreamEvent> {
  const gladiusConfig: ProviderConfig = {
    ...config,
    baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
    apiKey: config.apiKey ?? 'gladius-local', // local server, key optional
  };

  yield* openaiProvider.stream(messages, tools, gladiusConfig);
}

export const gladiusProvider: Provider = {
  name: 'gladius',
  stream: streamGladius,
};
