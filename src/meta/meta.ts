// Meta^n — Recursive meta-operation for self-improvement of routing rules.
// Takes Curator's proposed rule updates, applies them, validates whether they
// improve delivery outcomes, and commits or rolls back based on results.
//
// The "recursive" part: Meta^n uses the gateway's own output feedback to evaluate
// whether a rule change improved delivery quality. If it did, the change is committed.
// If not, it's rolled back. The evaluation itself uses the same routing system —
// making it a fixed meta-operation applied recursively.

import { getSarsi, getSarsiModel } from '../sarsi/index.js';
import { getCurator, RuleProposal, InteractionRecord } from '../curator/index.js';
import { RuleChange, SarsiModel, ProviderRule } from '../sarsi/model.js';

export interface MetaEvaluation {
  changeId: string;
  beforeMetrics: SarsiModel['metrics'];
  afterMetrics: SarsiModel['metrics'];
  improvement: number; // -1..1 — positive = improved, negative = degraded
  decision: 'commit' | 'rollback' | 'hold';
  reason: string;
}

export class MetaN {
  private evaluationHistory: MetaEvaluation[] = [];
  private activeEvaluations: Map<string, { change: RuleChange; beforeMetrics: SarsiModel['metrics'] }> = new Map();
  private readonly maxHistory = 200;
  private iterationCount = 0;

  /**
   * Run one Meta^n cycle:
   * 1. Get pending proposals from Curator
   * 2. Apply them (above threshold)
   * 3. Evaluate whether they improved outcomes
   * 4. Commit or rollback
   *
   * This is the "recursive route" — it uses the system's own routing to evaluate
   * whether the routing improved.
   */
  async runCycle(): Promise<MetaEvaluation[]> {
    this.iterationCount++;
    const curator = getCurator();
    const sarsi = getSarsi();
    const model = getSarsiModel();
    const evaluations: MetaEvaluation[] = [];

    // Snapshot before metrics
    const beforeMetrics = { ...model.metrics };

    // Get and apply proposals from Curator
    const appliedChanges = curator.applyProposals(0.5);

    if (appliedChanges.length === 0) {
      return evaluations; // Nothing to evaluate
    }

    // For each applied change, set up an evaluation window
    for (const change of appliedChanges) {
      this.activeEvaluations.set(change.id, {
        change,
        beforeMetrics: { ...beforeMetrics },
      });
    }

    // Evaluate each change based on the delta
    for (const change of appliedChanges) {
      const evaluation = this.evaluateChange(change, beforeMetrics, getSarsiModel().metrics);
      evaluations.push(evaluation);

      if (evaluation.decision === 'rollback') {
        sarsi.rollback(change.id);
        console.log(`[Meta^n] Rolled back ${change.id}: ${evaluation.reason}`);
      } else if (evaluation.decision === 'commit') {
        // Mark as verified
        change.verified = true;
        sarsi.recordChange(change);
        console.log(`[Meta^n] Committed ${change.id}: ${evaluation.reason}`);
      }
      // 'hold' = keep but don't verify yet — needs more data
    }

    // Store evaluation history
    this.evaluationHistory.push(...evaluations);
    if (this.evaluationHistory.length > this.maxHistory) {
      this.evaluationHistory = this.evaluationHistory.slice(-this.maxHistory);
    }

    return evaluations;
  }

  /**
   * Evaluate whether a specific change improved outcomes.
   * This is the core meta-operation — it compares before/after metrics.
   */
  private evaluateChange(
    change: RuleChange,
    before: SarsiModel['metrics'],
    after: SarsiModel['metrics'],
  ): MetaEvaluation {
    // Calculate improvement score
    // Weight: routingAccuracy (40%), toolSuccessRate (30%), latency (20%), tokenCost (10%)
    const routingDelta = (after.routingAccuracy - before.routingAccuracy) * 0.4;
    const toolDelta = (after.toolSuccessRate - before.toolSuccessRate) * 0.3;
    const latencyDelta = before.averageLatencyMs > 0
      ? ((before.averageLatencyMs - after.averageLatencyMs) / before.averageLatencyMs) * 0.2
      : 0;
    const tokenDelta = before.totalTokensUsed > 0
      ? ((before.totalTokensUsed - after.totalTokensUsed) / before.totalTokensUsed) * 0.1
      : 0;

    const improvement = routingDelta + toolDelta + latencyDelta + tokenDelta;

    let decision: 'commit' | 'rollback' | 'hold';
    let reason: string;

    if (improvement > 0.02) {
      decision = 'commit';
      reason = `Improvement score +${improvement.toFixed(3)} — routing ${before.routingAccuracy.toFixed(2)}→${after.routingAccuracy.toFixed(2)}, tool ${before.toolSuccessRate.toFixed(2)}→${after.toolSuccessRate.toFixed(2)}`;
    } else if (improvement < -0.03) {
      decision = 'rollback';
      reason = `Degradation score ${improvement.toFixed(3)} — change made things worse, reverting`;
    } else {
      decision = 'hold';
      reason = `Marginal change (score ${improvement.toFixed(3)}) — keeping but needs more data to verify`;
    }

    return {
      changeId: change.id,
      beforeMetrics: before,
      afterMetrics: after,
      improvement,
      decision,
      reason,
    };
  }

  /**
   * Feed an interaction outcome back into Meta^n.
   * This is the recursive part — the gateway's own output is used to evaluate
   * whether the routing rules are improving.
   */
  async feedOutcome(record: InteractionRecord): Promise<void> {
    // Record the outcome in SARSI metrics
    const sarsi = getSarsi();
    const model = getSarsiModel();

    // Determine if this interaction validates any pending evaluations
    for (const [changeId, evalState] of this.activeEvaluations) {
      // If the interaction used the provider/rule that was changed, it's relevant
      const change = evalState.change;
      if (change.ruleType === 'provider') {
        const rule = model.providerRules.find(r => r.id === change.ruleId);
        if (rule && rule.provider === record.provider) {
          // This interaction is affected by this change — evaluate
          const evaluation = this.evaluateChange(
            change,
            evalState.beforeMetrics,
            model.metrics,
          );

          if (evaluation.decision === 'rollback') {
            sarsi.rollback(changeId);
            console.log(`[Meta^n] Rolled back ${changeId} based on outcome: ${evaluation.reason}`);
          }

          this.activeEvaluations.delete(changeId);
        }
      }
    }
  }

  /** Get evaluation history for audit/debugging */
  getHistory(): MetaEvaluation[] {
    return [...this.evaluationHistory];
  }

  /** Get active evaluations still being monitored */
  getActiveCount(): number {
    return this.activeEvaluations.size;
  }

  /** Get Meta^n stats */
  getStats(): {
    iterations: number;
    evaluations: number;
    active: number;
    commits: number;
    rollbacks: number;
    holds: number;
  } {
    const commits = this.evaluationHistory.filter(e => e.decision === 'commit').length;
    const rollbacks = this.evaluationHistory.filter(e => e.decision === 'rollback').length;
    const holds = this.evaluationHistory.filter(e => e.decision === 'hold').length;
    return {
      iterations: this.iterationCount,
      evaluations: this.evaluationHistory.length,
      active: this.activeEvaluations.size,
      commits,
      rollbacks,
      holds,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton + background runner
// ─────────────────────────────────────────────────────────────────────────────

let metaInstance: MetaN | null = null;
let metaInterval: NodeJS.Timeout | null = null;

export function getMeta(): MetaN {
  if (!metaInstance) metaInstance = new MetaN();
  return metaInstance;
}

/**
 * Start the Meta^n background loop.
 * Runs a cycle every N interactions or on a timer.
 * @param intervalMs How often to run (default: every 5 minutes)
 */
export function startMetaLoop(intervalMs: number = 5 * 60 * 1000): void {
  if (metaInterval) return; // Already running
  const meta = getMeta();

  metaInterval = setInterval(async () => {
    try {
      const evaluations = await meta.runCycle();
      if (evaluations.length > 0) {
        console.log(`[Meta^n] Cycle complete — ${evaluations.length} evaluations: ${evaluations.filter(e => e.decision === 'commit').length} commits, ${evaluations.filter(e => e.decision === 'rollback').length} rollbacks, ${evaluations.filter(e => e.decision === 'hold').length} holds`);
      }
    } catch (err) {
      console.error('[Meta^n] Cycle failed:', err);
    }
  }, intervalMs);

  // Don't keep the process alive for this
  if (metaInterval.unref) metaInterval.unref();
  console.log(`[Meta^n] Background loop started — interval: ${intervalMs}ms`);
}

/** Stop the Meta^n background loop */
export function stopMetaLoop(): void {
  if (metaInterval) {
    clearInterval(metaInterval);
    metaInterval = null;
    console.log('[Meta^n] Background loop stopped');
  }
}

/** One-shot: run a single Meta^n cycle now */
export async function runMetaCycleNow(): Promise<MetaEvaluation[]> {
  return getMeta().runCycle();
}

/** Feed an interaction outcome to Meta^n for recursive evaluation (standalone wrapper) */
export async function feedOutcome(record: InteractionRecord): Promise<void> {
  return getMeta().feedOutcome(record);
}
