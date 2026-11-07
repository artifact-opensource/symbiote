import { discoverGitHubCopilotModels } from './github-copilot.js';

export interface ProviderModelConfig {
  apiKey?: string;
  accountId?: string;
  baseUrl?: string;
}

export interface ModelDiscoveryOptions {
  fetcher?: typeof fetch;
  copilotModelDiscovery?: () => Promise<string[]>;
}

const MODEL_CACHE_TTL_MS = 60_000;
const DEFAULT_MODEL_BASE_URLS: Record<string, string> = {
  anthropic: 'https://api.anthropic.com/v1',
  'artifact-engine': 'http://127.0.0.1:8080/v1',
  cloudflare: 'https://api.cloudflare.com/client/v4/accounts',
  freeai: 'https://api.freetheai.xyz/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  groq: 'https://api.groq.com/openai/v1',
  nvidia: 'https://integrate.api.nvidia.com/v1',
  ollama: 'http://127.0.0.1:11434',
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  xai: 'https://api.x.ai/v1',
};

const modelCache = new Map<string, { expiresAt: number; models: string[] }>();
const inFlight = new Map<string, Promise<string[]>>();

function modelEndpoint(providerName: string, config: ProviderModelConfig): string | undefined {
  if (providerName === 'github-copilot') return undefined;

  let baseUrl = (config.baseUrl ?? DEFAULT_MODEL_BASE_URLS[providerName])?.replace(/\/+$/, '');
  if (!baseUrl) return undefined;

  if (providerName === 'cloudflare') {
    const accountId = config.accountId?.trim() || process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
    if (!accountId || !/^[a-f0-9]{32}$/i.test(accountId)) {
      throw new Error('Cloudflare model discovery requires a 32-character hexadecimal account ID.');
    }
    if (!config.apiKey?.trim() && !process.env.CLOUDFLARE_API_TOKEN?.trim()) {
      throw new Error('Cloudflare model discovery requires CLOUDFLARE_API_TOKEN or providers.cloudflare.apiKey.');
    }
    return `${DEFAULT_MODEL_BASE_URLS.cloudflare}/${accountId}/ai/models/search?per_page=100&hide_experimental=true`;
  }

  if (providerName === 'ollama') {
    return baseUrl.endsWith('/api/tags') ? baseUrl : `${baseUrl}/api/tags`;
  }
  if (baseUrl.endsWith('/models')) return baseUrl;
  if (providerName === 'groq' && baseUrl.endsWith('/openai')) return `${baseUrl}/v1/models`;
  if (/\/v\d+(?:beta)?$/.test(baseUrl)) return `${baseUrl}/models`;
  return `${baseUrl}/v1/models`;
}

function parseModelIds(payload: unknown, providerName: string): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const response = payload as Record<string, unknown>;
  const candidates = Array.isArray(response.data)
    ? response.data
    : Array.isArray(response.result)
      ? response.result
    : Array.isArray(response.models)
      ? response.models
      : Array.isArray(response.tags)
        ? response.tags
        : [];
  const ids = candidates.flatMap((candidate): string[] => {
    if (typeof candidate === 'string') return [candidate];
    if (!candidate || typeof candidate !== 'object') return [];
    const model = candidate as Record<string, unknown>;
    if (providerName === 'cloudflare') {
      const task = model.task;
      if (task && typeof task === 'object'
        && typeof (task as Record<string, unknown>).name === 'string'
        && (task as Record<string, unknown>).name !== 'Text Generation') return [];
    }
    const id = providerName === 'cloudflare' && typeof model.name === 'string'
      ? model.name
      : typeof model.id === 'string'
        ? model.id
        : typeof model.name === 'string'
        ? model.name
        : typeof model.model === 'string'
          ? model.model
          : undefined;
    if (!id) return [];
    return [providerName === 'gemini' ? id.replace(/^models\//, '') : id];
  });
  return [...new Set(ids.filter(Boolean))].slice(0, 500);
}

async function fetchProviderModels(
  providerName: string,
  config: ProviderModelConfig,
  fetcher: typeof fetch,
): Promise<string[]> {
  if (providerName === 'github-copilot') return discoverGitHubCopilotModels();

  const endpoint = modelEndpoint(providerName, config);
  if (!endpoint) throw new Error(`No model-discovery endpoint is configured for provider "${providerName}".`);

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (providerName === 'anthropic') {
    if (!config.apiKey) throw new Error('Anthropic model discovery requires a configured API key.');
    headers['x-api-key'] = config.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (providerName === 'gemini') {
    if (!config.apiKey) throw new Error('Gemini model discovery requires a configured API key.');
    headers['x-goog-api-key'] = config.apiKey;
  } else if (providerName === 'freeai' && !config.apiKey?.trim()) {
    throw new Error('FreeAI model discovery requires an API key. Set FREEAI_API_KEY in .env.');
  } else if (providerName === 'cloudflare') {
    const apiKey = config.apiKey?.trim() || process.env.CLOUDFLARE_API_TOKEN?.trim();
    headers.Authorization = `Bearer ${apiKey}`;
  } else if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  const response = await fetcher(endpoint, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    throw new Error(`Model discovery for provider "${providerName}" failed (HTTP ${response.status}).`);
  }
  return parseModelIds(await response.json(), providerName);
}

export async function discoverProviderModels(
  providerName: string,
  config: ProviderModelConfig,
  options: ModelDiscoveryOptions = {},
): Promise<string[]> {
  const endpoint = providerName === 'github-copilot'
    ? 'github-copilot'
    : modelEndpoint(providerName, config);
  if (!endpoint) throw new Error(`No model-discovery endpoint is configured for provider "${providerName}".`);

  const key = `${providerName}:${endpoint}`;
  const cached = modelCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return [...cached.models];

  const pending = inFlight.get(key);
  if (pending) return [...await pending];

  const fetcher = options.fetcher ?? globalThis.fetch;
  const discovery = providerName === 'github-copilot' && options.copilotModelDiscovery
    ? options.copilotModelDiscovery()
    : fetchProviderModels(providerName, config, fetcher);
  inFlight.set(key, discovery);
  try {
    const models = await discovery;
    modelCache.set(key, { expiresAt: Date.now() + MODEL_CACHE_TTL_MS, models });
    return [...models];
  } finally {
    inFlight.delete(key);
  }
}
