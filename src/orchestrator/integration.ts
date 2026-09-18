// Integration Layer — Ties SARSI, Curator, Meta^n, MEA, and PARC together.
// This is the glue that connects the meta-cognitive subsystems to the existing runner.
//
// Flow:
//   1. Before LLM call: planRouting() → determines optimal provider
//   2. Runner executes (existing behavior)
//   3. After runner returns: auditGate() → MEA checks if response is adequate
//   4. After delivery: assessAndLearn() → PARC assessment + Curator review + Meta^n feedback

import { planRouting, assessRouting, ParcRoutingDecision } from './parc.js';
import { auditInteraction, MeaAuditResult, getMeaStats } from '../agent/mea.js';
import { reviewAsync } from '../curator/index.js';
import { feedOutcome, runMetaCycleNow } from '../meta/index.js';
import { recordOutcome, getSarsiModel } from '../sarsi/index.js';

export interface AgentRunResult {
  text: string;
  toolCalls: Array<{ name: string; input: unknown; result: string }>;
  iterations: number;
  aborted: boolean;
  maxIterationsHit: boolean;
  tokensUsed?: number;
  latencyMs?: number;
  hadErrors?: boolean;
}

export interface ChannelContext {
  channel: string;
  userMessage: string;
  contextLength: number;
}

/**
 * Step 1: Plan routing before the LLM call.
 * Returns the optimal provider/model based on SARSI rules.
 */
export function preRoute(
  userMessage: string,
  channel: string,
  contextLength: number,
): ParcRoutingDecision {
  return planRouting(userMessage, channel, contextLength);
}

/**
 * Step 3: MEA Audit Gate — runs after the agent loop, before delivery.
 * Returns whether the response passes the audit and should be delivered.
 */
export function auditGate(
  userMessage: string,
  taskType: string,
  result: AgentRunResult,
): { audit: MeaAuditResult; shouldDeliver: boolean } {
  const audit = auditInteraction({
    userMessage,
    taskType,
    toolCalls: result.toolCalls.map(tc => ({
      tool: tc.name,
      input: tc.input,
      output: tc.result,
      success: !String(tc.result).includes('"is_error":true'),
    })),
    response: result.text,
    latencyMs: result.latencyMs ?? 0,
    hadErrors: result.hadErrors ?? false,
  });

  getMeaStats().record(audit);

  return {
    audit,
    shouldDeliver: audit.passed || !audit.shouldRetry,
  };
}

/**
 * Step 4: Post-delivery assessment and learning.
 * Runs asynchronously — does NOT block the response.
 * Feeds outcome to SARSI metrics, Curator, and Meta^n.
 */
export function postDeliver(
  decision: ParcRoutingDecision,
  channelContext: ChannelContext,
  result: AgentRunResult,
  userSatisfied: boolean,
): void {
  const outcome = {
    tokensUsed: result.tokensUsed ?? 0,
    latencyMs: result.latencyMs ?? 0,
    toolSuccess: !result.hadErrors,
    userSatisfied,
    toolCallCount: result.toolCalls.length,
    delivered: true,
    response: result.text,
    userMessage: channelContext.userMessage,
    hadErrors: result.hadErrors ?? false,
  };

  // Fire and forget — all async, non-blocking
  setImmediate(async () => {
    try {
      // PARC assessment (feeds SARSI metrics + Curator + Meta^n)
      await assessRouting(decision, outcome, channelContext.channel);
    } catch (err) {
      console.error('[Integration] Post-deliver assessment failed:', err);
    }

    // Trigger a Meta^n cycle if enough proposals have accumulated
    try {
      const model = getSarsiModel();
      if (model.metrics.totalInteractions % 10 === 0) {
        // Every 10 interactions, run a Meta^n cycle to evaluate pending proposals
        await runMetaCycleNow();
      }
    } catch (err) {
      console.error('[Integration] Meta^n cycle failed:', err);
    }
  });
}

/**
 * Full pipeline — convenience function that wraps the entire flow.
 * Usage:
 *   const decision = preRoute(msg, channel, ctxLen);
 *   // ... run agent with decision.provider ...
 *   const { audit, shouldDeliver } = auditGate(msg, decision.taskType, result);
 *   if (shouldDeliver) { /* deliver *\/ }
 *   postDeliver(decision, { channel, userMessage: msg, contextLength: ctxLen }, result, true);
 */
export { planRouting, assessRouting } from './parc.js';
export { auditInteraction, getMeaStats, MeaStats } from '../agent/mea.js';
export { getCurator, reviewAsync } from '../curator/index.js';
export { getMeta, startMetaLoop, stopMetaLoop, runMetaCycleNow } from '../meta/index.js';
export { initSarsi, getSarsi, getSarsiModel, getSarsiPrompt, classifyTask, routeProvider, recordOutcome, shutdownSarsi } from '../sarsi/index.js';
