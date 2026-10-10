// Curator — Background post-interaction review
// Analyzes completed interactions and proposes rule updates to the SARSI model.
// Runs asynchronously (non-blocking) after each interaction.
// Has an "active-update bias" — prefers updating stale rules over preserving them.
//
// Bug detection (v5.1):
// - Tracks per-tool failure patterns across interactions (sliding window)
// - Minor bugs: single tool failure → suggest retry/timeout bump (low confidence)
// - Major bugs: repeated failures of the same tool → high-confidence proposal to
//   raise retries, extend timeout, or swap to a fallback tool
// - Also reviews provider routing quality, channel behavior, and token/latency goals

import { getSarsi, getSarsiModel } from '../sarsi/index.js';
import {
  SarsiModel,
  ProviderRule,
  ToolRule,
  ChannelRule,
  RuleChange,
} from '../sarsi/model.js';

export interface InteractionRecord {
  /** Unique ID for this interaction */
  id: string;
  /** Timestamp */
  timestamp: string;
  /** The task type that was classified */
  taskType: string;
  /** Provider used */
  provider: string;
  /** Model used */
  model: string;
  /** Tokens consumed */
  tokensUsed: number;
  /** Response latency in ms */
  latencyMs: number;
  /** Whether tool calls succeeded */
  toolSuccess: boolean;
  /** Whether the user seemed satisfied (e.g., no immediate follow-up correction) */
  userSatisfied: boolean;
  /** Number of tool calls made */
  toolCallCount: number;
  /** Whether the response was delivered successfully */
  delivered: boolean;
  /** Channel the interaction came from */
  channel: string;
  /** Whether routing was optimal (heuristic: low latency + high tokens efficiency + user satisfied) */
  routingWasOptimal: boolean;
  /** Per-tool results — enables fine-grained bug detection */
  toolResults?: Array<{ tool: string; success: boolean; error?: string }>;
}

export interface RuleProposal {
  id: string;
  ruleType: 'provider' | 'channel' | 'tool';
  ruleId: string;
  change: 'add' | 'modify' | 'remove';
  before?: unknown;
  after?: unknown;
  reason: string;
  confidence: number; // 0..1 — how confident the curator is
  priority: number; // 0..1 — how urgent
  /** Bug severity classification */
  severity?: 'minor' | 'major';
}

/** Per-tool failure tracking state */
interface ToolFailureState {
  failures: number;
  total: number;
  lastFailureAt: string | null;
  lastError?: string;
}

export class Curator {
  private pendingProposals: RuleProposal[] = [];
  private reviewCount = 0;
  private lastReviewTime: string | null = null;
  /** Sliding-window failure tracking per tool name */
  private toolFailures: Map<string, ToolFailureState> = new Map();
  /** Tools already flagged as major bugs (avoid duplicate proposals) */
  private majorBugCooldown: Map<string, number> = new Map();
  private readonly majorBugCooldownMs = 10 * 60 * 1000; // 10 min
  private readonly failureWindow = 20; // track last N interactions per tool

  /**
   * Review a completed interaction and generate rule proposals.
   * This is the core Curator loop — it runs async, non-blocking.
   */
  async reviewInteraction(record: InteractionRecord): Promise<RuleProposal[]> {
    this.reviewCount++;
    this.lastReviewTime = new Date().toISOString();
    const proposals: RuleProposal[] = [];
    const sarsi = getSarsi();
    const model = getSarsiModel();

    // ── Bug detection: update per-tool failure tracking ──
    if (record.toolResults && record.toolResults.length > 0) {
      for (const tr of record.toolResults) {
        this.trackToolOutcome(tr.tool, tr.success, tr.error);
      }
      proposals.push(...this.detectToolBugs(record, model));
    }

    // ── Check 1: Provider routing quality ──
    const providerRule = model.providerRules.find(r => r.taskType === record.taskType);

    if (providerRule) {
      if (!record.routingWasOptimal) {
        sarsi.adjustConfidence(providerRule.id, -0.05);
        proposals.push({
          id: `prop-${Date.now()}-1`,
          ruleType: 'provider',
          ruleId: providerRule.id,
          change: 'modify',
          before: { ...providerRule },
          after: {
            ...providerRule,
            priority: Math.max(0, providerRule.priority - 0.1),
            rationale: `Demoted by Curator: routing was suboptimal (latency: ${record.latencyMs}ms, tokens: ${record.tokensUsed}, satisfied: ${record.userSatisfied})`,
          },
          reason: `Provider ${record.provider}/${record.model} underperformed for task type ${record.taskType} (latency=${record.latencyMs}ms, tokens=${record.tokensUsed}, userSatisfied=${record.userSatisfied})`,
          confidence: 0.6,
          priority: 0.7,
          severity: 'minor',
        });
      } else if (record.userSatisfied && record.latencyMs < 3000) {
        sarsi.adjustConfidence(providerRule.id, +0.02);
      }
    }

    // ── Check 2: Token efficiency ──
    const costGoal = model.goals.find(g => g.metric === 'cost');
    if (costGoal && record.tokensUsed > costGoal.target * 2) {
      const alternatives = model.providerRules
        .filter(r => r.taskType === record.taskType && r.provider !== record.provider)
        .sort((a, b) => b.priority - a.priority);

      if (alternatives.length > 0) {
        const alt = alternatives[0];
        proposals.push({
          id: `prop-${Date.now()}-2`,
          ruleType: 'provider',
          ruleId: alt.id,
          change: 'modify',
          before: { ...alt },
          after: {
            ...alt,
            priority: Math.min(1, alt.priority + 0.15),
            rationale: `Promoted by Curator: ${record.provider} used ${record.tokensUsed} tokens (2x cost target), alternative ${alt.provider} may be more efficient`,
          },
          reason: `Token overflow: ${record.tokensUsed} >> target ${costGoal.target} for ${record.taskType}. Promoting ${alt.provider}/${alt.model}.`,
          confidence: 0.5,
          priority: 0.5,
          severity: 'minor',
        });
      }
    }

    // ── Check 3: Tool success rate (coarse — when no per-tool detail available) ──
    if (!record.toolSuccess && record.toolCallCount > 0 && !record.toolResults?.length) {
      proposals.push({
        id: `prop-${Date.now()}-3`,
        ruleType: 'tool',
        ruleId: 'global-tool-retry',
        change: 'modify',
        before: { toolSuccessRate: model.metrics.toolSuccessRate },
        after: { note: 'Tool failure detected — consider increasing retry count or timeout' },
        reason: `Tool failure in interaction ${record.id}: ${record.toolCallCount} tool calls, success=${record.toolSuccess}`,
        confidence: 0.4,
        priority: 0.3,
        severity: 'minor',
      });
    }

    // ── Check 4: Latency check ──
    const latencyGoal = model.goals.find(g => g.metric === 'latency');
    if (latencyGoal && record.latencyMs > latencyGoal.target * 2) {
      proposals.push({
        id: `prop-${Date.now()}-4`,
        ruleType: 'provider',
        ruleId: providerRule?.id ?? 'unknown',
        change: 'modify',
        before: providerRule ? { ...providerRule } : undefined,
        after: {
          ...(providerRule ?? {}),
          priority: Math.max(0, (providerRule?.priority ?? 0.5) - 0.05),
          rationale: `Demoted by Curator: latency ${record.latencyMs}ms >> target ${latencyGoal.target}ms`,
        },
        reason: `Latency overflow: ${record.latencyMs}ms >> ${latencyGoal.target}ms target for ${record.taskType}`,
        confidence: 0.55,
        priority: 0.6,
        severity: 'minor',
      });
    }

    // ── Check 5: Active-update bias — flag suboptimal routing for review ──
    if (proposals.length === 0 && !record.routingWasOptimal) {
      proposals.push({
        id: `prop-${Date.now()}-review`,
        ruleType: 'provider',
        ruleId: providerRule?.id ?? 'unknown',
        change: 'modify',
        before: providerRule ? { ...providerRule } : undefined,
        after: { note: 'Flagged for manual review — suboptimal routing detected but no specific fix proposed' },
        reason: `Suboptimal routing for ${record.taskType} but no clear alternative. Interaction ${record.id}.`,
        confidence: 0.3,
        priority: 0.2,
        severity: 'minor',
      });
    }

    this.pendingProposals.push(...proposals);
    return proposals;
  }

  /**
   * Track a single tool outcome in the sliding window.
   */
  private trackToolOutcome(tool: string, success: boolean, error?: string): void {
    let state = this.toolFailures.get(tool);
    if (!state) {
      state = { failures: 0, total: 0, lastFailureAt: null, lastError: undefined };
      this.toolFailures.set(tool, state);
    }
    state.total++;
    if (!success) {
      state.failures++;
      state.lastFailureAt = new Date().toISOString();
      state.lastError = error;
    }
    // Keep window bounded
    if (state.total > this.failureWindow) {
      state.total--;
      state.failures = Math.max(0, state.failures - 1);
    }
  }

  /**
   * Detect tool bugs from the failure window.
   * - Minor: 1 failure in window → low-confidence retry/timeout bump
   * - Major: >= 3 failures (or >= 50% failure rate with >= 3 samples) →
   *   high-confidence proposal to raise retries, extend timeout, or use fallback
   */
  private detectToolBugs(record: InteractionRecord, model: SarsiModel): RuleProposal[] {
    const proposals: RuleProposal[] = [];
    const now = Date.now();

    for (const [tool, state] of this.toolFailures) {
      if (state.failures === 0) continue;

      const failureRate = state.total > 0 ? state.failures / state.total : 0;
      const isMajor = state.failures >= 3 || (failureRate >= 0.5 && state.total >= 3);
      const inCooldown = this.majorBugCooldown.get(tool);
      if (isMajor && inCooldown && now - inCooldown < this.majorBugCooldownMs) continue;

      // Find the matching tool rule (by preferredTool or fallbackTool name)
      const rule = model.toolRules.find(r => r.preferredTool === tool || r.fallbackTool === tool);

      if (isMajor) {
        this.majorBugCooldown.set(tool, now);
        const newRetries = rule ? Math.min(10, rule.maxRetries + 2) : 3;
        const newTimeout = rule ? Math.min(120000, rule.timeoutMs * 2) : 30000;
        const fallback = rule?.fallbackTool && rule.fallbackTool !== tool ? rule.fallbackTool : undefined;

        proposals.push({
          id: `prop-${Date.now()}-major-${tool}`,
          ruleType: 'tool',
          ruleId: rule?.id ?? `auto-${tool}`,
          change: rule ? 'modify' : 'add',
          before: rule ? { ...rule } : undefined,
          after: rule
            ? { ...rule, maxRetries: newRetries, timeoutMs: newTimeout, rationale: `Major bug: ${state.failures}/${state.total} failures in window. Last error: ${state.lastError ?? 'unknown'}` }
            : {
                id: `auto-${tool}`,
                operation: tool,
                preferredTool: tool,
                maxRetries: newRetries,
                timeoutMs: newTimeout,
                conditions: ['auto-created by Curator'],
              },
          reason: `MAJOR BUG: tool '${tool}' failed ${state.failures}/${state.total} times (rate ${(failureRate * 100).toFixed(0)}%). Last error: ${state.lastError ?? 'unknown'}. ${fallback ? `Fallback available: ${fallback}.` : ''} Raising retries to ${newRetries} and timeout to ${newTimeout}ms.`,
          confidence: 0.75,
          priority: 0.85,
          severity: 'major',
        });
      } else {
        // Minor bug — only propose if we haven't already flagged this tool recently
        if (inCooldown && now - inCooldown < this.majorBugCooldownMs) continue;
        const newRetries = rule ? Math.min(10, rule.maxRetries + 1) : 2;
        const newTimeout = rule ? Math.min(120000, Math.round(rule.timeoutMs * 1.5)) : 20000;

        proposals.push({
          id: `prop-${Date.now()}-minor-${tool}`,
          ruleType: 'tool',
          ruleId: rule?.id ?? `auto-${tool}`,
          change: rule ? 'modify' : 'add',
          before: rule ? { ...rule } : undefined,
          after: rule
            ? { ...rule, maxRetries: newRetries, timeoutMs: newTimeout, rationale: `Minor bug: ${state.failures}/${state.total} failures in window. Last error: ${state.lastError ?? 'unknown'}` }
            : {
                id: `auto-${tool}`,
                operation: tool,
                preferredTool: tool,
                maxRetries: newRetries,
                timeoutMs: newTimeout,
                conditions: ['auto-created by Curator'],
              },
          reason: `MINOR BUG: tool '${tool}' failed ${state.failures}/${state.total} times. Last error: ${state.lastError ?? 'unknown'}. Bumping retries to ${newRetries} and timeout to ${newTimeout}ms.`,
          confidence: 0.5,
          priority: 0.4,
          severity: 'minor',
        });
      }
    }

    return proposals;
  }

  /**
   * Apply pending proposals to the SARSI model.
   * This is what Meta^n calls — it takes the proposals and commits them.
   * Only applies proposals with confidence >= threshold.
   */
  applyProposals(threshold: number = 0.5): RuleChange[] {
    const sarsi = getSarsi();
    const model = getSarsiModel();
    const applied: RuleChange[] = [];
    const remaining: RuleProposal[] = [];

    for (const proposal of this.pendingProposals) {
      if (proposal.confidence < threshold) {
        remaining.push(proposal);
        continue;
      }

      const change: RuleChange = {
        id: `change-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        ruleType: proposal.ruleType,
        ruleId: proposal.ruleId,
        change: proposal.change,
        before: proposal.before,
        after: proposal.after,
        source: 'curator',
        reason: proposal.reason,
        verified: false, // Meta^n will verify later
        rollback: true,
      };

      // Apply the change to the model
      this.applyChangeToModel(model, proposal);
      sarsi.recordChange(change);
      applied.push(change);
    }

    this.pendingProposals = remaining;
    console.log(`[Curator] Applied ${applied.length} proposals (${remaining.length} below threshold ${threshold})`);
    return applied;
  }

  /** Get pending proposals (for Meta^n to evaluate) */
  getPendingProposals(): RuleProposal[] {
    return [...this.pendingProposals];
  }

  /** Clear proposals (after Meta^n has processed them) */
  clearProposals(): void {
    this.pendingProposals = [];
  }

  /** Get curator stats */
  getStats(): {
    reviewCount: number;
    lastReviewTime: string | null;
    pendingCount: number;
    trackedTools: number;
    majorBugs: number;
  } {
    return {
      reviewCount: this.reviewCount,
      lastReviewTime: this.lastReviewTime,
      pendingCount: this.pendingProposals.length,
      trackedTools: this.toolFailures.size,
      majorBugs: [...this.toolFailures.values()].filter(s => s.failures >= 3).length,
    };
  }

  /** Apply a single proposal to the model in-place */
  private applyChangeToModel(model: SarsiModel, proposal: RuleProposal): void {
    switch (proposal.ruleType) {
      case 'provider': {
        const idx = model.providerRules.findIndex(r => r.id === proposal.ruleId);
        if (proposal.change === 'modify' && idx >= 0 && proposal.after) {
          model.providerRules[idx] = { ...model.providerRules[idx], ...(proposal.after as Partial<ProviderRule>) };
        } else if (proposal.change === 'add' && proposal.after) {
          model.providerRules.push(proposal.after as ProviderRule);
        } else if (proposal.change === 'remove' && idx >= 0) {
          model.providerRules.splice(idx, 1);
        }
        break;
      }
      case 'tool': {
        const idx = model.toolRules.findIndex(r => r.id === proposal.ruleId);
        if (proposal.change === 'modify' && idx >= 0 && proposal.after) {
          model.toolRules[idx] = { ...model.toolRules[idx], ...(proposal.after as Partial<ToolRule>) };
        } else if (proposal.change === 'add' && proposal.after) {
          model.toolRules.push(proposal.after as ToolRule);
        } else if (proposal.change === 'remove' && idx >= 0) {
          model.toolRules.splice(idx, 1);
        }
        break;
      }
      case 'channel': {
        const idx = model.channelRules.findIndex(r => r.id === proposal.ruleId);
        if (proposal.change === 'modify' && idx >= 0 && proposal.after) {
          model.channelRules[idx] = { ...model.channelRules[idx], ...(proposal.after as Partial<ChannelRule>) };
        } else if (proposal.change === 'add' && proposal.after) {
          model.channelRules.push(proposal.after as ChannelRule);
        } else if (proposal.change === 'remove' && idx >= 0) {
          model.channelRules.splice(idx, 1);
        }
        break;
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton
// ─────────────────────────────────────────────────────────────────────────────

let curatorInstance: Curator | null = null;

export function getCurator(): Curator {
  if (!curatorInstance) curatorInstance = new Curator();
  return curatorInstance;
}

/**
 * Convenience: review an interaction asynchronously (non-blocking).
 * Call this after each completed interaction from runner.ts.
 */
export function reviewAsync(record: InteractionRecord): void {
  const curator = getCurator();
  // Fire and forget — don't block the response
  setImmediate(async () => {
    try {
      const proposals = await curator.reviewInteraction(record);
      if (proposals.length > 0) {
        console.log(`[Curator] Reviewed interaction ${record.id} — ${proposals.length} proposals generated`);
      }
    } catch (err) {
      console.error(`[Curator] Review failed for ${record.id}:`, err);
    }
  });
}
