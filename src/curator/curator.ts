// Curator — Background post-interaction review
// Analyzes completed interactions and proposes rule updates to the SARSI model.
// Runs asynchronously (non-blocking) after each interaction.
// Has an "active-update bias" — prefers updating stale rules over preserving them.

import { getSarsi, getSarsiModel } from '../sarsi/index.js';
import {
  SarsiModel,
  ProviderRule,
  ToolRule,
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
}

export class Curator {
  private pendingProposals: RuleProposal[] = [];
  private reviewCount = 0;
  private lastReviewTime: string | null = null;

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

    // ── Check 1: Provider routing quality ──
    const providerRule = model.providerRules.find(
      r => r.taskType === record.taskType
    );

    if (providerRule) {
      // Was the routing suboptimal?
      if (!record.routingWasOptimal) {
        // Penalty — decrease confidence in this rule
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
        });
      } else if (record.userSatisfied && record.latencyMs < 3000) {
        // Reward — increase confidence
        sarsi.adjustConfidence(providerRule.id, +0.02);
      }
    }

    // ── Check 2: Token efficiency ──
    // If tokens used significantly exceeded the cost goal, flag it
    const costGoal = model.goals.find(g => g.metric === 'cost');
    if (costGoal && record.tokensUsed > costGoal.target * 2) {
      // Find if there's an alternative provider for this task type
      const alternatives = model.providerRules
        .filter(r => r.taskType === record.taskType && r.provider !== record.provider)
        .sort((a, b) => b.priority - a.priority);

      if (alternatives.length > 0) {
        // Propose promoting the alternative
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
        });
      }
    }

    // ── Check 3: Tool success rate ──
    if (!record.toolSuccess && record.toolCallCount > 0) {
      // Find the tool rule for the operation that failed
      // (We don't have per-tool granularity here, but we can flag the overall tool rule set)
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
      });
    }

    // ── Check 4: Latency check ──
    const latencyGoal = model.goals.find(g => g.metric === 'latency');
    if (latencyGoal && record.latencyMs > latencyGoal.target * 2) {
      // Find a faster provider for this task type
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
      });
    }

    // ── Active-update bias: if no proposals generated but interaction was suboptimal, flag for review ──
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
      });
    }

    this.pendingProposals.push(...proposals);
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
  getStats(): { reviewCount: number; lastReviewTime: string | null; pendingCount: number } {
    return {
      reviewCount: this.reviewCount,
      lastReviewTime: this.lastReviewTime,
      pendingCount: this.pendingProposals.length,
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
        // Channel rules are simpler — just enable/disable
        const idx = model.channelRules.findIndex(r => r.id === proposal.ruleId);
        if (proposal.change === 'modify' && idx >= 0 && proposal.after) {
          model.channelRules[idx] = { ...model.channelRules[idx], ...(proposal.after as any) };
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
