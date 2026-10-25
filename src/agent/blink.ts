// Symbiote — BLINK: Seamless Session Continuation
//
// The wall doesn't exist.
//
// When an agent loop approaches its iteration budget, BLINK ensures continuity.
// Instead of dying with "[Max iterations reached]", the agent:
//
// 1. Records continuation state before the iteration budget is exhausted
// 2. Returns a blink signal to the daemon
// 3. Daemon starts a fresh agent turn with the saved session history
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
  maxDepth: number;        // Max consecutive blinks per conversation (default: unlimited)
  prepareAt: number;       // Mark continuation state at N iterations remaining (default: 3)
  cooldownMs: number;      // Delay between blink and resume (default: 1000)
  checkpointInterval: number;  // Record a runtime checkpoint every N iterations (default: 25, 0 = disabled)
}

export const DEFAULT_BLINK_CONFIG: BlinkConfig = {
  enabled: true,
  maxDepth: Number.POSITIVE_INFINITY,
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
  prepared: boolean;           // Whether continuation state was marked this cycle
  lastCheckpointAt: number;    // Iteration of the last runtime checkpoint
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

export function isBlinkControlMessage(content: unknown): boolean {
  return typeof content === 'string'
    && (/^\s*(?:(?:\u{26A1}\s*)?BLINK APPROACHING —|(?:\u{1F516}\s*)?CHECKPOINT —|(?:\u{26A1}\s*)?BLINK COMPLETE —|(?:\u{26A0}\u{FE0F}\s*)?SYSTEM WARNING:)/u.test(content)
      || /^\s*Internal completion review:\s*/i.test(content)
      || /^\s*Checklist verification found unfinished tasks:\s*/i.test(content));
}

export function stripBlinkControlMessages<T extends { role: string; content: unknown }>(messages: T[]): T[] {
  const visible: T[] = [];
  for (const message of messages) {
    if ((message.role === 'user' || message.role === 'system') && isBlinkControlMessage(message.content)) {
      if (message.role === 'system'
        && typeof message.content === 'string'
        && /^\s*Internal completion review:\s*/i.test(message.content)) {
        const previous = visible[visible.length - 1];
        const hasToolCalls = previous && 'tool_calls' in previous
          && Array.isArray(previous.tool_calls)
          && previous.tool_calls.length > 0;
        if (previous?.role === 'assistant' && typeof previous.content === 'string' && !hasToolCalls) {
          visible.pop();
        }
      }
      continue;
    }
    visible.push(message);
  }
  return visible;
}


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

  /** Should we mark continuation state?
   *  Called by runner at each iteration.
   *  @param remaining - iterations remaining before budget exhaustion
   */
  shouldPrepare(remaining: number): boolean {
    if (!this.config.enabled) return false;
    if (this.state.prepared) return false;
    return remaining <= this.config.prepareAt;
  }

  /** Should we record a periodic checkpoint?
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
    // Don't checkpoint if we just prepared.
    if (this.state.prepared) return false;
    // Check if we've passed the next checkpoint boundary
    const itersSinceCheckpoint = currentIteration - this.state.lastCheckpointAt;
    return itersSinceCheckpoint >= this.config.checkpointInterval;
  }

  /** Record a checkpoint without injecting a user-visible chat message. */
  recordCheckpoint(currentIteration: number): void {
    this.state.lastCheckpointAt = currentIteration;
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

  /** Mark that the current budget is approaching its continuation boundary. */
  markPrepared(): void {
    this.state.prepared = true;
    this.state.phase = 'prepare';
  }

  /** Record a blink event (agent hit budget, about to spawn fresh turn) */
  recordBlink(iterations: number, toolCalls: number): void {
    this.state.depth++;
    this.state.totalIterations += iterations;
    this.state.totalToolCalls += toolCalls;
    this.state.blinkTimestamps.push(Date.now());
    if (this.state.blinkTimestamps.length > 100) this.state.blinkTimestamps.shift();
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
