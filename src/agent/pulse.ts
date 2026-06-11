// Symbiote — PULSE: Adaptive Iteration Budget Manager
// 
// Default cap: 20 iterations per turn
// If a turn hits 18 iterations → runner auto-expands to 100 (within that turn)
// If 3 consecutive sessions all iterate under 10 → revert effective cap back to 20
//
// This module tracks cross-session iteration history and manages the effective cap.

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';

const DEFAULT_CAP = 20;
const EXPANDED_CAP = 100;
const EXPAND_THRESHOLD = 18;
const REVERT_WINDOW = 3;       // Check last N sessions
const REVERT_THRESHOLD = 10;   // If all N sessions < this, revert

interface PulseState {
  effectiveCap: number;
  recentIterations: number[];   // Last N session iteration counts (most recent last)
  expandedAt?: number;          // Timestamp when cap was expanded
  revertedAt?: number;          // Timestamp when cap was last reverted
}

const DEFAULT_STATE: PulseState = {
  effectiveCap: DEFAULT_CAP,
  recentIterations: [],
};

export class PulseBudgetManager {
  private state: PulseState;
  private statePath: string;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.statePath = join(stateDir, 'pulse-budget.json');
    this.state = this.load();
  }

  /** Get the current effective iteration cap for new turns */
  getEffectiveCap(): number {
    return this.state.effectiveCap;
  }

  /** Record a completed session's iteration count and evaluate revert */
  recordSession(iterations: number): { reverted: boolean; effectiveCap: number } {
    this.state.recentIterations.push(iterations);

    // Keep only the last REVERT_WINDOW entries
    if (this.state.recentIterations.length > REVERT_WINDOW) {
      this.state.recentIterations = this.state.recentIterations.slice(-REVERT_WINDOW);
    }

    // Check revert condition: if cap is expanded AND last N sessions all < threshold
    let reverted = false;
    if (
      this.state.effectiveCap > DEFAULT_CAP &&
      this.state.recentIterations.length >= REVERT_WINDOW &&
      this.state.recentIterations.every(n => n < REVERT_THRESHOLD)
    ) {
      console.log(
        `[PULSE] Reverting cap ${this.state.effectiveCap} → ${DEFAULT_CAP}: ` +
        `last ${REVERT_WINDOW} sessions all under ${REVERT_THRESHOLD} iterations ` +
        `(${this.state.recentIterations.join(', ')})`
      );
      this.state.effectiveCap = DEFAULT_CAP;
      this.state.revertedAt = Date.now();
      reverted = true;
    }

    this.save();
    return { reverted, effectiveCap: this.state.effectiveCap };
  }

  /** Called by runner when expansion triggers (iteration 18 hit) */
  markExpanded(): void {
    if (this.state.effectiveCap < EXPANDED_CAP) {
      this.state.effectiveCap = EXPANDED_CAP;
      this.state.expandedAt = Date.now();
      this.save();
    }
  }

  /** Get current state for diagnostics */
  getState(): Readonly<PulseState> {
    return { ...this.state };
  }

  private load(): PulseState {
    try {
      const raw = readFileSync(this.statePath, 'utf-8');
      return { ...DEFAULT_STATE, ...JSON.parse(raw) };
    } catch {
      return { ...DEFAULT_STATE };
    }
  }

  private save(): void {
    try {
      writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
    } catch (err) {
      console.error(`[PULSE] Failed to save state: ${err}`);
    }
  }
}

// Constants exported for runner.ts
export { DEFAULT_CAP, EXPANDED_CAP, EXPAND_THRESHOLD, REVERT_WINDOW, REVERT_THRESHOLD };
