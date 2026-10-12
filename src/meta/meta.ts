// Meta^n — evaluates routing and tool-policy changes against observed outcomes.
// A rule change is retained only when matched runtime samples demonstrate benefit.

import { getSarsi, getSarsiModel } from '../sarsi/index.js';
import { Curator, getCurator, type InteractionRecord, type RuleProposal } from '../curator/index.js';
import type { RuleChange, SarsiModel } from '../sarsi/model.js';
import fs from 'node:fs';
import path from 'node:path';

const MIN_BASELINE_SAMPLES = 8;
const MIN_CANDIDATE_SAMPLES = 8;
const MAX_CANDIDATE_SAMPLES = 20;
const MAX_BASELINE_SAMPLES = 20;
const MIN_EFFECT = 0.05;
const MAX_HISTORY = 200;
const MAX_OUTCOME_HISTORY = 1000;

interface OutcomeSample {
  record: InteractionRecord;
  score: number;
}

interface ActiveEvaluation {
  change: RuleChange;
  baselineMetrics: SarsiModel['metrics'];
  baselineScores: number[];
  candidateScores: number[];
  opportunities: number;
}

export interface MetaEvaluation {
  changeId: string;
  beforeMetrics: SarsiModel['metrics'];
  afterMetrics: SarsiModel['metrics'];
  improvement: number;
  decision: 'commit' | 'rollback' | 'hold';
  reason: string;
  baselineSamples?: number;
  candidateSamples?: number;
  confidenceInterval?: [number, number];
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleVariance(values: number[], average: number): number {
  if (values.length < 2) return 0;
  return values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
}

function outcomeScore(record: InteractionRecord): number {
  const latencyTarget = getSarsiModel().goals.find(goal => goal.metric === 'latency')?.target ?? 2000;
  const tokenTarget = getSarsiModel().goals.find(goal => goal.metric === 'cost')?.target ?? 500;
  const toolSuccess = record.toolResults?.length
    ? record.toolResults.filter(result => result.success).length / record.toolResults.length
    : Number(record.toolSuccess);
  const latencyScore = 1 / (1 + Math.max(0, record.latencyMs) / latencyTarget);
  const tokenScore = 1 / (1 + Math.max(0, record.tokensUsed) / tokenTarget);

  return 0.4 * Number(record.userSatisfied)
    + 0.2 * Number(record.delivered)
    + 0.2 * toolSuccess
    + 0.1 * latencyScore
    + 0.1 * tokenScore;
}

function changeBefore(change: RuleChange): Record<string, unknown> {
  return change.before && typeof change.before === 'object'
    ? change.before as Record<string, unknown>
    : {};
}

function changeAfter(change: RuleChange): Record<string, unknown> {
  return change.after && typeof change.after === 'object'
    ? change.after as Record<string, unknown>
    : {};
}

export class MetaN {
  private evaluationHistory: MetaEvaluation[] = [];
  private activeEvaluations = new Map<string, ActiveEvaluation>();
  private outcomeHistory: OutcomeSample[] = [];
  private readonly seenOutcomeIds = new Set<string>();
  private iterationCount = 0;
  private readonly statePath?: string;
  private readonly curator: Curator;

  constructor(statePath?: string, curator: Curator = getCurator()) {
    this.statePath = statePath;
    this.curator = curator;
    if (statePath) this.restore();
  }

  /**
   * Apply only proposals that have enough matched baseline evidence. Evaluation
   * begins with later outcomes; applying a change never counts as evidence.
   */
  async runCycle(): Promise<MetaEvaluation[]> {
    this.iterationCount++;
    const model = getSarsiModel();
    const pending = this.curator.getPendingProposals();
    const reservedRules = new Set<string>();
    const appliedChanges = this.curator.applyProposals(0.5, proposal => {
      const key = `${proposal.ruleType}:${proposal.ruleId}`;
      const alreadyEvaluating = [...this.activeEvaluations.values()]
        .some(active => active.change.ruleType === proposal.ruleType && active.change.ruleId === proposal.ruleId);
      if (alreadyEvaluating || reservedRules.has(key)) return false;
      if ((this.baselineFor(proposal, pending)?.length ?? 0) < MIN_BASELINE_SAMPLES) return false;
      reservedRules.add(key);
      return true;
    });

    for (const change of appliedChanges) {
      const baseline = this.baselineForChange(change);
      if (!baseline || baseline.length < MIN_BASELINE_SAMPLES) {
        // The proposal may have changed while being applied; do not leave an
        // unobservable change active.
        getSarsi().rollback(change.id);
        continue;
      }
      this.activeEvaluations.set(change.id, {
        change,
        baselineMetrics: { ...model.metrics },
        baselineScores: baseline.map(sample => this.scoreForChange(change, sample.record, sample.score)),
        candidateScores: [],
        opportunities: 0,
      });
    }

    this.persist();
    if (appliedChanges.length > 0) {
      console.log(`[Meta^n] Applied ${this.activeEvaluations.size} evidence-eligible changes; awaiting matched outcomes`);
    }
    return [];
  }

  /** Record an interaction and evaluate only changes it could have affected. */
  async feedOutcome(record: InteractionRecord): Promise<void> {
    if (this.seenOutcomeIds.has(record.id)) return;

    const sample: OutcomeSample = { record, score: outcomeScore(record) };
    this.seenOutcomeIds.add(record.id);
    this.outcomeHistory.push(sample);
    if (this.outcomeHistory.length > MAX_OUTCOME_HISTORY) {
      const removed = this.outcomeHistory.splice(0, this.outcomeHistory.length - MAX_OUTCOME_HISTORY);
      for (const old of removed) this.seenOutcomeIds.delete(old.record.id);
    }

    for (const [changeId, active] of this.activeEvaluations) {
      if (!this.matchesOpportunity(active.change, record)) continue;
      active.opportunities++;
      if (this.matchesCandidate(active.change, record)) {
        active.candidateScores.push(this.scoreForChange(active.change, record, sample.score));
      }

      const evaluation = this.evaluate(active);
      if (evaluation.decision === 'hold') continue;

      const sarsi = getSarsi();
      if (evaluation.decision === 'rollback') {
        sarsi.rollback(changeId);
        console.log(`[Meta^n] Rolled back ${changeId}: ${evaluation.reason}`);
      } else {
        active.change.verified = true;
        sarsi.recordChange(active.change);
        console.log(`[Meta^n] Committed ${changeId}: ${evaluation.reason}`);
      }
      this.activeEvaluations.delete(changeId);
      this.evaluationHistory.push(evaluation);
      if (this.evaluationHistory.length > MAX_HISTORY) {
        this.evaluationHistory = this.evaluationHistory.slice(-MAX_HISTORY);
      }
    }
    this.persist();
  }

  private baselineFor(proposal: RuleProposal, proposals: RuleProposal[]): OutcomeSample[] | undefined {
    const applicable = proposals.find(item => item.id === proposal.id);
    if (!applicable) return undefined;
    return this.outcomeHistory
      .filter(sample => this.matchesBaselineProposal(proposal, sample.record))
      .slice(-MAX_BASELINE_SAMPLES);
  }

  private baselineForChange(change: RuleChange): OutcomeSample[] {
    return this.outcomeHistory
      .filter(sample => this.matchesBaselineChange(change, sample.record))
      .slice(-MAX_BASELINE_SAMPLES);
  }

  private matchesBaselineProposal(proposal: RuleProposal, record: InteractionRecord): boolean {
    if (proposal.ruleType === 'provider') {
      const before = proposal.before as { taskType?: string } | undefined;
      return !!before?.taskType && record.taskType === before.taskType;
    }
    if (proposal.ruleType === 'tool') {
      const before = proposal.before as { preferredTool?: string } | undefined;
      const tool = before?.preferredTool;
      return !!tool && !!record.toolResults?.some(result => result.tool === tool);
    }
    return false;
  }

  private matchesBaselineChange(change: RuleChange, record: InteractionRecord): boolean {
    if (change.ruleType === 'provider') {
      const before = changeBefore(change);
      return typeof before.taskType === 'string'
        && record.taskType === before.taskType;
    }
    if (change.ruleType === 'tool') {
      const tool = changeBefore(change).preferredTool;
      return typeof tool === 'string' && !!record.toolResults?.some(result => result.tool === tool);
    }
    return false;
  }

  private matchesCandidate(change: RuleChange, record: InteractionRecord): boolean {
    if (change.ruleType === 'provider') {
      const after = changeAfter(change);
      return typeof after.taskType === 'string'
        && record.taskType === after.taskType
        && record.routingRuleId === change.ruleId
        && (typeof after.provider !== 'string' || record.provider === after.provider);
    }
    if (change.ruleType === 'tool') {
      const tool = changeAfter(change).preferredTool;
      return typeof tool === 'string' && !!record.toolResults?.some(result => result.tool === tool);
    }
    return false;
  }

  private matchesOpportunity(change: RuleChange, record: InteractionRecord): boolean {
    if (change.ruleType === 'provider') {
      return record.taskType === changeAfter(change).taskType;
    }
    if (change.ruleType === 'tool') {
      const tool = changeBefore(change).preferredTool ?? changeAfter(change).preferredTool;
      return typeof tool === 'string' && !!record.toolResults?.some(item => item.tool === tool);
    }
    return false;
  }

  private scoreForChange(change: RuleChange, record: InteractionRecord, overallScore: number): number {
    if (change.ruleType !== 'tool') return overallScore;
    const tool = changeAfter(change).preferredTool ?? changeBefore(change).preferredTool;
    const result = record.toolResults?.find(item => item.tool === tool);
    if (!result) return 0;
    const latencyTarget = getSarsiModel().goals.find(goal => goal.metric === 'latency')?.target ?? 2000;
    const latencyScore = 1 / (1 + Math.max(0, record.latencyMs) / latencyTarget);
    return 0.8 * Number(result.success) + 0.2 * latencyScore;
  }

  private evaluate(active: ActiveEvaluation): MetaEvaluation {
    const baseline = active.baselineScores;
    const candidate = active.candidateScores;
    const model = getSarsiModel();
    if (candidate.length < MIN_CANDIDATE_SAMPLES) {
      if (active.opportunities >= MAX_CANDIDATE_SAMPLES) {
        const reason = candidate.length === 0
          ? `The changed route was not selected in ${active.opportunities} matching task opportunities; reverting ineffective change`
          : `Only ${candidate.length}/${MIN_CANDIDATE_SAMPLES} candidate outcomes were observed in ${active.opportunities} matching opportunities; reverting unproven change`;
        return {
          changeId: active.change.id,
          beforeMetrics: active.baselineMetrics,
          afterMetrics: { ...model.metrics },
          improvement: 0,
          decision: 'rollback',
          reason,
          baselineSamples: baseline.length,
          candidateSamples: candidate.length,
        };
      }
      return {
        changeId: active.change.id,
        beforeMetrics: active.baselineMetrics,
        afterMetrics: { ...model.metrics },
        improvement: 0,
        decision: 'hold',
        reason: `Collecting matched candidate outcomes (${candidate.length}/${MIN_CANDIDATE_SAMPLES})`,
        baselineSamples: baseline.length,
        candidateSamples: candidate.length,
      };
    }

    const before = baseline.length > 0 ? mean(baseline) : 0;
    const after = mean(candidate);
    const improvement = after - before;
    const standardError = baseline.length > 1
      ? Math.sqrt(sampleVariance(baseline, before) / baseline.length + sampleVariance(candidate, after) / candidate.length)
      : Number.POSITIVE_INFINITY;
    const confidenceInterval: [number, number] = [
      improvement - 1.96 * standardError,
      improvement + 1.96 * standardError,
    ];

    let decision: MetaEvaluation['decision'] = 'hold';
    let reason = `No decision yet: observed change ${improvement >= 0 ? '+' : ''}${improvement.toFixed(3)}`;
    if (baseline.length < MIN_BASELINE_SAMPLES) {
      decision = active.opportunities >= MAX_CANDIDATE_SAMPLES ? 'rollback' : 'hold';
      reason = `No valid baseline evidence for this change (${baseline.length}/${MIN_BASELINE_SAMPLES}); ${decision === 'rollback' ? 'reverting unverified change' : 'collecting bounded candidate sample'}`;
    } else if (improvement >= MIN_EFFECT && confidenceInterval[0] > 0) {
      decision = 'commit';
      reason = `Matched samples show improvement +${improvement.toFixed(3)} (95% CI ${confidenceInterval[0].toFixed(3)} to ${confidenceInterval[1].toFixed(3)})`;
    } else if (improvement <= -MIN_EFFECT && confidenceInterval[1] < 0) {
      decision = 'rollback';
      reason = `Matched samples show regression ${improvement.toFixed(3)} (95% CI ${confidenceInterval[0].toFixed(3)} to ${confidenceInterval[1].toFixed(3)})`;
    } else if (active.opportunities >= MAX_CANDIDATE_SAMPLES) {
      decision = 'rollback';
      reason = `No demonstrated improvement after ${active.opportunities} matching opportunities (score ${improvement >= 0 ? '+' : ''}${improvement.toFixed(3)}); reverting`;
    }

    return {
      changeId: active.change.id,
      beforeMetrics: active.baselineMetrics,
      afterMetrics: { ...model.metrics },
      improvement,
      decision,
      reason,
      baselineSamples: baseline.length,
      candidateSamples: candidate.length,
      confidenceInterval,
    };
  }

  /** Get evaluation history for audit/debugging. */
  getHistory(): MetaEvaluation[] {
    return [...this.evaluationHistory];
  }

  /** Get active evaluations still being monitored. */
  getActiveCount(): number {
    return this.activeEvaluations.size;
  }

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

  private restore(): void {
    if (!this.statePath || !fs.existsSync(this.statePath)) return;
    try {
      const state = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as {
        version: number;
        iterationCount: number;
        evaluationHistory: MetaEvaluation[];
        activeEvaluations: Array<[string, ActiveEvaluation | { change: RuleChange; beforeMetrics: SarsiModel['metrics'] }]>;
        outcomeHistory?: OutcomeSample[];
      };
      if (![1, 2].includes(state.version) || !Array.isArray(state.evaluationHistory)
        || !Array.isArray(state.activeEvaluations) || !Number.isInteger(state.iterationCount)
        || state.iterationCount < 0 || (state.version === 2 && !Array.isArray(state.outcomeHistory))) {
        throw new Error('unsupported or malformed Meta^n state');
      }
      this.iterationCount = state.iterationCount;
      this.evaluationHistory = state.evaluationHistory.slice(-MAX_HISTORY);
      this.activeEvaluations = new Map(state.activeEvaluations.map(([id, value]) => [
        id,
        'baselineScores' in value
          ? { ...value, opportunities: value.opportunities ?? value.candidateScores.length }
          : { change: value.change, baselineMetrics: value.beforeMetrics, baselineScores: [], candidateScores: [], opportunities: 0 },
      ]));
      this.outcomeHistory = (state.outcomeHistory ?? []).slice(-MAX_OUTCOME_HISTORY);
      this.seenOutcomeIds.clear();
      for (const sample of this.outcomeHistory) this.seenOutcomeIds.add(sample.record.id);
    } catch (error) {
      throw new Error(`Failed to restore Meta^n state from ${this.statePath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  private persist(): void {
    if (!this.statePath) return;
    const directory = path.dirname(this.statePath);
    fs.mkdirSync(directory, { recursive: true });
    const temporaryPath = `${this.statePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify({
      version: 2,
      iterationCount: this.iterationCount,
      evaluationHistory: this.evaluationHistory,
      activeEvaluations: [...this.activeEvaluations],
      outcomeHistory: this.outcomeHistory,
    }, null, 2), 'utf8');
    fs.renameSync(temporaryPath, this.statePath);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton + background runner
// ─────────────────────────────────────────────────────────────────────────────

let metaInstance: MetaN | null = null;
let metaInterval: NodeJS.Timeout | null = null;

export function getMeta(): MetaN {
  if (!metaInstance) metaInstance = new MetaN(path.join(process.cwd(), '.symbiote', 'meta-state.json'));
  return metaInstance;
}

/** Start the Meta^n background loop. */
export function startMetaLoop(intervalMs: number = 5 * 60 * 1000): void {
  if (metaInterval) return;
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

  if (metaInterval.unref) metaInterval.unref();
  console.log(`[Meta^n] Background loop started — interval: ${intervalMs}ms`);
}

export function stopMetaLoop(): void {
  if (metaInterval) {
    clearInterval(metaInterval);
    metaInterval = null;
    console.log('[Meta^n] Background loop stopped');
  }
}

export async function runMetaCycleNow(): Promise<MetaEvaluation[]> {
  return getMeta().runCycle();
}

export async function feedOutcome(record: InteractionRecord): Promise<void> {
  return getMeta().feedOutcome(record);
}
