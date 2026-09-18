// SARSI Boot Loader — Loads the self-model at daemon startup and injects it into context.
// This runs once at boot (unified-daemon.ts) and makes the SARSI model available system-wide.

import { SarsiStore, SarsiModel } from './model.js';
import { existsSync } from 'fs';
import { join } from 'path';

let store: SarsiStore | null = null;

/** Initialize SARSI at boot — call from unified-daemon.ts */
export function initSarsi(baseDir?: string): SarsiStore {
  const dir = baseDir ?? join(process.cwd(), '.symbiote');
  store = new SarsiStore(dir);
  const model = store.load();
  console.log(`[SARSI] Boot complete — identity: ${model.identity.name}/${model.identity.role}, ${model.providerRules.length} provider rules, ${model.toolRules.length} tool rules, ${model.ruleHistory.length} history entries`);
  return store;
}

/** Get the global SARSI store (throws if not initialized) */
export function getSarsi(): SarsiStore {
  if (!store) {
    // Auto-init if not explicitly initialized
    store = initSarsi();
  }
  return store;
}

/** Get the current SARSI model */
export function getSarsiModel(): SarsiModel {
  return getSarsi().load();
}

/** Get the system-prompt-injectable SARSI string */
export function getSarsiPrompt(): string {
  return getSarsi().toSystemPrompt();
}

/** Classify a message into a task type for provider routing */
export function classifyTask(message: string): string {
  const lower = message.toLowerCase();
  
  // Code-related
  if (/\b(code|function|class|method|bug|fix|implement|refactor|typescript|python|javascript|api|endpoint)\b/.test(lower)) {
    return 'code';
  }
  
  // Reasoning
  if (/\b(why|analyze|reason|explain|compare|evaluate|decide|strategy|architecture|design)\b/.test(lower)) {
    return 'reasoning';
  }
  
  // Creative
  if (/\b(write|create|compose|story|poem|creative|brainstorm|imagine)\b/.test(lower)) {
    return 'creative';
  }
  
  // Long context
  if (message.length > 5000) {
    return 'long_context';
  }
  
  // Simple Q&A
  return 'simple_qa';
}

/** Route a task to the best provider based on SARSI rules */
export function routeProvider(taskType: string): { provider: string; model: string; ruleId: string; confidence: number } | null {
  const model = getSarsiModel();
  
  // Find matching rules for this task type, sorted by priority * confidence
  const matches = model.providerRules
    .filter(r => r.taskType === taskType)
    .map(r => ({
      provider: r.provider,
      model: r.model,
      ruleId: r.id,
      confidence: model.confidence[r.id] ?? 0.5,
      score: r.priority * (model.confidence[r.id] ?? 0.5),
    }))
    .sort((a, b) => b.score - a.score);
  
  if (matches.length === 0) return null;
  
  const best = matches[0];
  return {
    provider: best.provider,
    model: best.model,
    ruleId: best.ruleId,
    confidence: best.confidence,
  };
}

/** Record an interaction outcome for SARSI metrics */
export function recordOutcome(
  taskType: string,
  provider: string,
  model: string,
  tokensUsed: number,
  latencyMs: number,
  toolSuccess: boolean,
  routingWasOptimal: boolean,
): void {
  const s = getSarsi();
  const m = s.load();
  
  const newInteractions = m.metrics.totalInteractions + 1;
  const newTokens = m.metrics.totalTokensUsed + tokensUsed;
  const newAvgLatency = (m.metrics.averageLatencyMs * m.metrics.totalInteractions + latencyMs) / newInteractions;
  const newToolSuccess = (m.metrics.toolSuccessRate * m.metrics.totalInteractions + (toolSuccess ? 1 : 0)) / newInteractions;
  const newRoutingAccuracy = (m.metrics.routingAccuracy * m.metrics.totalInteractions + (routingWasOptimal ? 1 : 0)) / newInteractions;
  
  s.updateMetrics({
    totalInteractions: newInteractions,
    totalTokensUsed: newTokens,
    averageLatencyMs: newAvgLatency,
    toolSuccessRate: newToolSuccess,
    routingAccuracy: newRoutingAccuracy,
  });
}

/** Shutdown SARSI — flush pending state */
export function shutdownSarsi(): void {
  if (store) {
    console.log('[SARSI] Shutdown — state persisted');
    store = null;
  }
}
