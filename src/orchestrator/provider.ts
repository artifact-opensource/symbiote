// Symbiote — Orchestrator Provider Wrapper
// Exposes DualLLMOrchestrator as a standard Provider
// Ported from Sirius B (Victus) — adapted for AVA's full provider ecosystem

import type { Message, ToolDef, ProviderConfig, StreamEvent, Provider } from '../providers/types.js';
import { DualLLMOrchestrator, OrchestratorConfig } from './dual-llm.js';
import { loadConfig } from '../config/config.js';
import { ToolRegistry } from '../tools/registry.js';
// Import ALL providers available in AVA's ecosystem
import { openrouterProvider } from '../providers/openrouter.js';
import { anthropicProvider } from '../providers/anthropic.js';
import { openaiProvider } from '../providers/openai.js';
import { githubCopilotProvider } from '../providers/github-copilot.js';
import { vscodeProxyProvider } from '../providers/vscode-proxy.js';
import { geminiProvider } from '../providers/gemini.js';
import { gladiusProvider } from '../providers/gladius.js';
import { groqProvider } from '../providers/groq.js';
import { ollamaProvider } from '../providers/ollama.js';
import { xaiProvider } from '../providers/xai.js';

let orchestratorInstance: DualLLMOrchestrator | null = null;

/**
 * Create and initialize the orchestrator singleton.
 * Call this during boot sequence with the daemon's REAL tool registry.
 */
export async function initializeOrchestrator(toolRegistry: ToolRegistry): Promise<DualLLMOrchestrator | null> {
  if (orchestratorInstance) return orchestratorInstance;

  const config = loadConfig();
  const orchCfg = config.orchestrator;
  
  if (!orchCfg?.enabled) {
    return null;
  }

  // Validate required config
  if (!orchCfg.cloudModel) {
    throw new Error('Orchestrator enabled but cloudModel not specified');
  }
  if (!orchCfg.localModels || Object.keys(orchCfg.localModels).length === 0) {
    throw new Error('Orchestrator enabled but no local models configured');
  }

  // Build cloud provider based on cloudProvider setting (supports ALL AVA providers)
  const cloudProviderName = orchCfg.cloudProvider ?? 'github-copilot';
  const cloudProvider = getProviderByName(cloudProviderName);
  if (!cloudProvider) {
    throw new Error(`Unknown cloud provider: ${cloudProviderName}`);
  }

  // Get cloud provider config from mach6.json providers section
  const cloudProviderConfig = config.providers[cloudProviderName as keyof typeof config.providers] ?? {};

  // Wrap cloud provider to inject config and force model
  const wrappedCloudProvider: Provider = {
    name: cloudProviderName,
    stream: (messages, tools, _providerConfig) => {
      const mergedConfig: ProviderConfig = {
        ...cloudProviderConfig as any,
        ..._providerConfig,
        model: orchCfg.cloudModel!,
      };
      return cloudProvider.stream(messages, tools, mergedConfig);
    },
  };

  // Build local providers — route through the SAME cloud provider with different models
  // This allows using copilot proxy models (gpt-5.4-mini, gemini-3-flash, etc.) as "local" workers
  // Falls back to Ollama wrapping if cloudProvider is 'ollama'
  const localProviders = new Map<string, Provider>();
  for (const [modelKey, modelName] of Object.entries(orchCfg.localModels as Record<string, string>)) {
    if (modelName) {
      // Route through the same provider as cloud (e.g., copilot proxy) but with a different model
      localProviders.set(modelKey, createModelProvider(cloudProvider, modelName, cloudProviderConfig));
    }
  }

  // Build orchestrator config
  const orchestratorConfig: OrchestratorConfig = {
    enabled: true,
    cloudProvider: cloudProviderName,
    cloudModel: orchCfg.cloudModel,
    localModels: orchCfg.localModels,
    maxParallel: orchCfg.maxParallel ?? 3,
    taskTimeoutMs: orchCfg.taskTimeoutMs ?? 300_000,
    decompositionPrompt: orchCfg.decompositionPrompt,
    synthesisPrompt: orchCfg.synthesisPrompt,
  };

  orchestratorInstance = new DualLLMOrchestrator(wrappedCloudProvider, localProviders, orchestratorConfig, toolRegistry);
  return orchestratorInstance;
}

/**
 * Get the orchestrator provider for use in the main PROVIDERS map.
 * Must be called after initializeOrchestrator().
 */
export function getOrchestratorProvider(): Provider | null {
  if (!orchestratorInstance) {
    return null;
  }
  return {
    name: 'orchestrator',
    stream: (messages, tools, config) => orchestratorInstance!.stream(messages, tools, config),
  };
}

/**
 * Full provider lookup — covers every provider in AVA's ecosystem.
 * This is the orchestrator's own registry (separate from daemon's PROVIDERS map).
 */
function getProviderByName(name: string): Provider {
  switch (name) {
    case 'openrouter':
      return openrouterProvider;
    case 'anthropic':
      return anthropicProvider;
    case 'openai':
      return openaiProvider;
    case 'github-copilot':
      return githubCopilotProvider;
    case 'vscode-proxy':
      return vscodeProxyProvider;
    case 'gemini':
      return geminiProvider;
    case 'gladius':
      return gladiusProvider;
    case 'groq':
      return groqProvider;
    case 'ollama':
      return ollamaProvider;
    case 'xai':
      return xaiProvider;
    default:
      throw new Error(`Unknown provider: ${name}. Available: openrouter, anthropic, openai, github-copilot, vscode-proxy, gemini, gladius, groq, ollama, xai`);
  }
}

/** Create a provider wrapper that forces a specific model through any base provider */
function createModelProvider(baseProvider: Provider, modelName: string, baseConfig: Record<string, unknown>): Provider {
  return {
    name: `${baseProvider.name}/${modelName}`,
    stream: (messages, tools, config) => {
      const mergedConfig: ProviderConfig = {
        ...baseConfig as any,
        ...config,
        model: modelName,
      };
      return baseProvider.stream(messages, tools, mergedConfig);
    },
  };
}

/** Create an Ollama provider wrapper that forces a specific model (legacy/fallback) */
function getOllamaProvider(modelName: string, ollamaConfig: Record<string, unknown>): Provider {
  return {
    name: 'ollama',
    stream: (messages, tools, config) => {
      const mergedConfig: ProviderConfig = {
        ...ollamaConfig as any,
        ...config,
        model: modelName,
      };
      return ollamaProvider.stream(messages, tools, mergedConfig);
    },
  };
}
