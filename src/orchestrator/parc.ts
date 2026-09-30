// PARC — Parallel Routing Agents for routing decisions
// Extends the existing orchestrator (dual-llm.ts) by adding routing decisions
// as first-class DAG nodes. Instead of building a parallel system, PARC adds
// three specialized node types to the existing DAG:
//
//   P (Planning)   — evaluates the message and determines the optimal routing
//   A (Assessment) — evaluates the routing quality post-delivery
//   R (Routing)    — the actual routing decision node
//
// These run as parallel DAG branches alongside the existing task decomposition.

import { getSarsiModel, classifyTask, routeProvider, recordOutcome } from '../sarsi/index.js';
import { reviewAsync } from '../curator/index.js';
import { auditInteraction, MeaAuditContext, MeaAuditResult, getMeaStats } from '../agent/mea.js';
import { feedOutcome } from '../meta/index.js';

export type ParcNodeType = 'planning' | 'routing' | 'assessment';

export interface ParcRoutingDecision {
  taskType: string;
  provider: string;
  model: string;
  ruleId: string;
  confidence: number;
  reasoning: string;
}

export interface ParcAssessmentResult {
  routingQuality: number; // 0..1
  latencyScore: number; // 0..1
  tokenEfficiency: number; // 0..1
  overallScore: number; // 0..1
  notes: string;
}

/**
 * PARC Planning Node — analyzes the incoming message and determines
 * the optimal routing strategy. This runs BEFORE the main LLM call.
 */
export function planRouting(
  message: string,
  channel: string,
  contextLength: number,
): ParcRoutingDecision {
  const taskType = classifyTask(message);
  const model = getSarsiModel();

  // Check for context-length-specific overrides
  let effectiveTaskType = taskType;
  if (contextLength > 50000) {
    effectiveTaskType = 'long_context';
  }

  const routing = routeProvider(effectiveTaskType);

  if (!routing) {
    // Fallback: use the default provider from config
    return {
      taskType: effectiveTaskType,
      provider: 'groq', // sensible default
      model: 'llama-3.3-70b',
      ruleId: 'fallback',
      confidence: 0.3,
      reasoning: `No SARSI rule found for task type "${effectiveTaskType}" — using fallback`,
    };
  }

  return {
    taskType: effectiveTaskType,
    provider: routing.provider,
    model: routing.model,
    ruleId: routing.ruleId,
    confidence: routing.confidence,
    reasoning: `Routed to ${routing.provider}/${routing.model} for ${effectiveTaskType} (confidence: ${routing.confidence.toFixed(2)})`,
  };
}

/**
 * PARC Assessment Node — evaluates the routing quality after delivery.
 * This runs AFTER the response is sent, in the background.
 */
export async function assessRouting(
  decision: ParcRoutingDecision,
  outcome: {
    tokensUsed: number;
    latencyMs: number;
    toolSuccess: boolean;
    userSatisfied: boolean;
    toolCallCount: number;
    delivered: boolean;
    response: string;
    userMessage: string;
    hadErrors: boolean;
  },
  channel: string,
): Promise<ParcAssessmentResult> {
  const model = getSarsiModel();

  // Latency score: how close to the latency goal?
  const latencyGoal = model.goals.find(g => g.metric === 'latency');
  const latencyTarget = latencyGoal?.target ?? 2000;
  const latencyScore = Math.max(0, Math.min(1, 1 - (outcome.latencyMs - latencyTarget) / (latencyTarget * 3)));

  // Token efficiency: how close to the cost goal?
  const costGoal = model.goals.find(g => g.metric === 'cost');
  const costTarget = costGoal?.target ?? 500;
  const tokenEfficiency = Math.max(0, Math.min(1, 1 - (outcome.tokensUsed - costTarget) / (costTarget * 5)));

  // Routing quality: did we pick the right provider?
  // Heuristic: if user was satisfied and no errors, routing was good
  const routingQuality = outcome.userSatisfied && outcome.delivered ? 0.9 : 0.4;

  // Overall score: weighted combination
  const overallScore = (routingQuality * 0.4) + (latencyScore * 0.3) + (tokenEfficiency * 0.3);

  const notes = [
    `Routing: ${routingQuality.toFixed(2)}`,
    `Latency: ${latencyScore.toFixed(2)} (${outcome.latencyMs}ms vs ${latencyTarget}ms target)`,
    `Tokens: ${tokenEfficiency.toFixed(2)} (${outcome.tokensUsed} vs ${costTarget} target)`,
    `Provider: ${decision.provider}/${decision.model}`,
    `Task: ${decision.taskType}`,
  ].join(' | ');

  // ── Feed the assessment back into the system ──

  // 1. Record outcome in SARSI metrics
  const routingWasOptimal = overallScore > 0.6;
  recordOutcome(
    decision.taskType,
    decision.provider,
    decision.model,
    outcome.tokensUsed,
    outcome.latencyMs,
    outcome.toolSuccess,
    routingWasOptimal,
  );

  // 2. Run MEA audit gate
  const meaContext: MeaAuditContext = {
    userMessage: outcome.userMessage,
    taskType: decision.taskType,
    toolCalls: [], // Populated by the runner if tools were used
    response: outcome.response,
    latencyMs: outcome.latencyMs,
    hadErrors: outcome.hadErrors,
  };
  const auditResult = auditInteraction(meaContext);
  getMeaStats().record(auditResult);

  // 3. Feed to Curator for background review
  reviewAsync({
    id: `interaction-${Date.now()}`,
    timestamp: new Date().toISOString(),
    taskType: decision.taskType,
    provider: decision.provider,
    model: decision.model,
    tokensUsed: outcome.tokensUsed,
    latencyMs: outcome.latencyMs,
    toolSuccess: outcome.toolSuccess,
    userSatisfied: outcome.userSatisfied,
    toolCallCount: outcome.toolCallCount,
    delivered: outcome.delivered,
    channel,
    routingWasOptimal,
  });

  // 4. Feed outcome to Meta^n for recursive evaluation
  feedOutcome({
    id: `interaction-${Date.now()}`,
    timestamp: new Date().toISOString(),
    taskType: decision.taskType,
    provider: decision.provider,
    model: decision.model,
    tokensUsed: outcome.tokensUsed,
    latencyMs: outcome.latencyMs,
    toolSuccess: outcome.toolSuccess,
    userSatisfied: outcome.userSatisfied,
    toolCallCount: outcome.toolCallCount,
    delivered: outcome.delivered,
    channel,
    routingWasOptimal,
  });

  return {
    routingQuality,
    latencyScore,
    tokenEfficiency,
    overallScore,
    notes,
  };
}

/**
 * Full PARC pipeline — plan → route → assess.
 * Call this from the runner after the LLM response is generated.
 */
export async function parcPipeline(
  userMessage: string,
  channel: string,
  contextLength: number,
  outcome: {
    tokensUsed: number;
    latencyMs: number;
    toolSuccess: boolean;
    userSatisfied: boolean;
    toolCallCount: number;
    delivered: boolean;
    response: string;
    userMessage: string;
    hadErrors: boolean;
  },
): Promise<{
  decision: ParcRoutingDecision;
  assessment: ParcAssessmentResult;
}> {
  // P: Plan routing (runs before LLM call in practice, but we call it here for the decision record)
  const decision = planRouting(userMessage, channel, contextLength);

  // A: Assess routing (runs after delivery)
  const assessment = await assessRouting(decision, outcome, channel);

  return { decision, assessment };
}
