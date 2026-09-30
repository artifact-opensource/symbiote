// Symbiote — BLINK: Seamless Session Continuation
//
// The wall doesn't exist.
//
// When an agent loop approaches its iteration budget, BLINK ensures continuity.
// Instead of dying with "[Max iterations reached]", the agent:
//
// 1. Gets a gentle nudge at BLINK_PREPARE iterations remaining
//    → "Summarize your state. You're about to blink."
// 2. Flushes state (COMB stage via tool call)
// 3. Returns a blink signal to the daemon
// 4. Daemon spawns a FRESH agent turn on the same session
// 5. New turn reads session history + COMB → picks up seamlessly
// 6. The user never sees the wall
//
// Ported from Singularity's cortex/blink.py — same philosophy, TypeScript runtime.
//
// v2 (2026-03-04): PULSE-aware checkpoints
//   - Re-arms after PULSE expansion (wall moved → recalibrate)
//   - Periodic checkpoint messages every N iterations for long runs
//   - External kill safety: checkpoints ensure state is staged regularly

export interface BlinkConfig {
  enabled: boolean;
  maxDepth: number;        // Max consecutive blinks per conversation (default: 5)
  prepareAt: number;       // Inject preparation message at N iterations remaining (default: 3)
  cooldownMs: number;      // Delay between blink and resume (default: 1000)
  checkpointInterval: number;  // Inject checkpoint nudge every N iterations (default: 25, 0 = disabled)
}

export const DEFAULT_BLINK_CONFIG: BlinkConfig = {
  enabled: true,
  maxDepth: 5,
  prepareAt: 3,
  cooldownMs: 1000,
  checkpointInterval: 25,
};

export type BlinkPhase = 'normal' | 'prepare' | 'blinking' | 'resumed' | 'capped';

export interface BlinkState {
  depth: number;               // How many blinks so far this conversation
  phase: BlinkPhase;
  totalIterations: number;     // Sum across all blinks
  totalToolCalls: number;
  blinkTimestamps: number[];
  prepared: boolean;           // Whether prepare message was injected this cycle
  lastCheckpointAt: number;    // Iteration when last checkpoint was injected
  capExpansions: number;       // How many times PULSE expanded the cap
}

function freshState(): BlinkState {
  return {
    depth: 0,
    phase: 'normal',
    totalIterations: 0,
    totalToolCalls: 0,
    blinkTimestamps: [],
    prepared: false,
    lastCheckpointAt: 0,
    capExpansions: 0,
  };
}

export const BLINK_PREPARE_MESSAGE = `⚡ BLINK APPROACHING — You are about to seamlessly continue into a fresh iteration budget.

**What to do NOW:**
1. If you have work in progress, keep going — you will NOT be interrupted
2. Your conversation history and context will carry over automatically
3. Do NOT write "[Budget exhausted]" or any termination message
4. Do NOT say goodbye or wrap up — just keep working
5. If you're mid-task, continue exactly where you are

You will blink and resume with full budget. The user sees nothing. Continuity is automatic.`;

export const BLINK_CHECKPOINT_MESSAGE = `🔖 CHECKPOINT — You have been running for a while. This is a periodic safety save.

**What to do NOW (in this order):**
1. If you have critical work-in-progress state, call \`comb_stage\` with a brief summary of what you're doing and where you are
2. Then continue working normally — this is NOT a shutdown, just a save point
3. If you have nothing critical to save, ignore this and keep working

This checkpoint exists so that if the session is interrupted externally, your progress is recoverable.`;

export const BLINK_RESUME_MESSAGE = (depth: number, maxDepth: number, totalIterations: number) =>
  `⚡ BLINK COMPLETE — You are continuing from where you left off.

**Context:** You blinked (seamless budget refresh). Your previous conversation history is fully intact above. Pick up EXACTLY where you left off. Do not re-introduce yourself, re-read files you already read, or repeat work. Continue the task in progress.

**Blink depth:** ${depth}/${maxDepth}
**Total iterations so far:** ${totalIterations}`;


export class BlinkController {
  private config: BlinkConfig;
  private state: BlinkState;

  constructor(config?: Partial<BlinkConfig>) {
    this.config = { ...DEFAULT_BLINK_CONFIG, ...config };
    this.state = freshState();
  }

  /** Can we do another blink? */
  shouldContinue(): boolean {
    if (!this.config.enabled) return this.state.depth === 0;
    return this.state.depth < this.config.maxDepth;
  }

  /** Does this agent result require a blink?
   *  Called by daemon after runAgent returns.
   *  maxIterationsHit = true when the agent exhausted its budget.
   */
  needsBlink(maxIterationsHit: boolean): boolean {
    if (!this.config.enabled) return false;
    if (!maxIterationsHit) return false;
    if (this.state.depth >= this.config.maxDepth) {
      this.state.phase = 'capped';
      console.log(`[BLINK] Depth capped at ${this.config.maxDepth}. Total iterations: ${this.state.totalIterations}`);
      return false;
    }
    return true;
  }

  /** Should we inject the preparation message?
   *  Called by runner at each iteration.
   *  @param remaining - iterations remaining before budget exhaustion
   */
  shouldPrepare(remaining: number): boolean {
    if (!this.config.enabled) return false;
    if (this.state.prepared) return false;
    return remaining <= this.config.prepareAt;
  }

  /** Should we inject a periodic checkpoint message?
   *  Called by runner at each iteration — separate from prepare.
   *  Checkpoints ensure state is saved regularly during long runs,
   *  so external kills (SIGTERM, OOM, crash) don't lose everything.
   *  @param currentIteration - the current iteration number (1-based)
   */
  shouldCheckpoint(currentIteration: number): boolean {
    if (!this.config.enabled) return false;
    if (this.config.checkpointInterval <= 0) return false;
    // Don't checkpoint in the first few iterations (bootup)
    if (currentIteration < this.config.checkpointInterval) return false;
    // Don't checkpoint if we just prepared (avoid double-messaging)
    if (this.state.prepared) return false;
    // Check if we've passed the next checkpoint boundary
    const itersSinceCheckpoint = currentIteration - this.state.lastCheckpointAt;
    return itersSinceCheckpoint >= this.config.checkpointInterval;
  }

  /** Get the checkpoint message and record that we checkpointed */
  getCheckpointMessage(currentIteration: number): string {
    this.state.lastCheckpointAt = currentIteration;
    return BLINK_CHECKPOINT_MESSAGE;
  }

  /** Notify that PULSE expanded the iteration cap.
   *  Re-arms the prepare flag so BLINK will fire again near the NEW wall.
   *  Called by runner immediately after PULSE expansion.
   */
  notifyCapExpanded(oldCap: number, newCap: number): void {
    this.state.prepared = false;  // Re-arm: the wall moved, need to prepare again near the new wall
    this.state.capExpansions++;
    console.log(
      `[BLINK] Cap expanded ${oldCap} → ${newCap}. ` +
      `Prepare re-armed (will fire at iteration ${newCap - this.config.prepareAt}). ` +
      `Expansion #${this.state.capExpansions}`
    );
  }

  /** Get the preparation system message to inject into context */
  getPrepareMessage(): string {
    this.state.prepared = true;
    this.state.phase = 'prepare';
    return BLINK_PREPARE_MESSAGE;
  }

  /** Get the resume system message for the new turn after blink */
  getResumeMessage(): string {
    this.state.phase = 'resumed';
    return BLINK_RESUME_MESSAGE(this.state.depth, this.config.maxDepth, this.state.totalIterations);
  }

  /** Record a blink event (agent hit budget, about to spawn fresh turn) */
  recordBlink(iterations: number, toolCalls: number): void {
    this.state.depth++;
    this.state.totalIterations += iterations;
    this.state.totalToolCalls += toolCalls;
    this.state.blinkTimestamps.push(Date.now());
    this.state.prepared = false;  // Reset for next cycle
    this.state.lastCheckpointAt = 0;  // Reset checkpoint counter for new cycle
    this.state.phase = 'blinking';

    console.log(
      `[BLINK] #${this.state.depth} — ` +
      `${iterations} iterations, ${toolCalls} tool calls, ` +
      `total: ${this.state.totalIterations} iterations`
    );
  }

  /** Record final completion (no more blinks needed) */
  recordComplete(iterations: number, toolCalls: number): void {
    this.state.totalIterations += iterations;
    this.state.totalToolCalls += toolCalls;
    this.state.phase = 'normal';
  }

  /** Get cooldown duration in ms */
  getCooldownMs(): number {
    return this.config.cooldownMs;
  }

  /** Get current state for diagnostics */
  getState(): Readonly<BlinkState> {
    return { ...this.state };
  }

  /** Get config for diagnostics */
  getConfig(): Readonly<BlinkConfig> {
    return { ...this.config };
  }
}
