import type { Provider } from './types.js';

const PROVIDER_API_KEYS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

export interface ProviderRouteChoice {
  name: string;
  provider: Provider;
  model: string;
  routed: boolean;
}

export function selectProviderRoute(
  decision: { provider: string; model: string },
  registry: ReadonlyMap<string, Provider>,
  providerConfigs: Record<string, { apiKey?: string } | undefined>,
  fallback: Omit<ProviderRouteChoice, 'routed'>,
): ProviderRouteChoice {
  const provider = registry.get(decision.provider);
  if (!provider) return { ...fallback, routed: false };

  const envKey = PROVIDER_API_KEYS[decision.provider];
  const hasApiKey = Boolean(providerConfigs[decision.provider]?.apiKey || (envKey && process.env[envKey]));
  if (decision.provider !== fallback.name && !hasApiKey) {
    return { ...fallback, routed: false };
  }

  return {
    name: decision.provider,
    provider,
    model: decision.model,
    routed: true,
  };
}