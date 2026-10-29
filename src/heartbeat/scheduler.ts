// Symbiote — Activity-Aware Heartbeat Scheduler (fixes Pain #11)
// Scales frequency based on user activity. Respects quiet hours.
import { describeHeartbeatError } from './automation.js';

export interface HeartbeatConfig {
  /** Minutes between heartbeats when user is active (last msg <1h). Default: 30 */
  activeIntervalMin: number;
  /** Minutes between heartbeats when idle (1-4h). Default: 120 */
  idleIntervalMin: number;
  /** Minutes between heartbeats when sleeping (>4h). Default: 360 */
  sleepingIntervalMin: number;
  /** Quiet hours start (0-23, local time). Default: 23 */
  quietHoursStart: number;
  /** Quiet hours end (0-23, local time). Default: 8 */
  quietHoursEnd: number;
  /** Return true only when a concrete, explicitly authorized task is available. */
  hasWork?: () => boolean;
}

export type ActivityState = 'active' | 'idle' | 'sleeping';

const DEFAULT_CONFIG: HeartbeatConfig = {
  activeIntervalMin: 30,
  idleIntervalMin: 120,
  sleepingIntervalMin: 360,
  quietHoursStart: 23,
  quietHoursEnd: 8,
};

export class HeartbeatScheduler {
  private config: HeartbeatConfig;
  private lastUserMessage = 0;
  private lastHeartbeat = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private onHeartbeat?: () => Promise<void>;
  private onError?: (error: unknown) => void;
  private callbackRunning = false;
  private consecutiveFailures = 0;
  private retryAfter = 0;
  private paused = false;
  private lastError?: string;

  constructor(config?: Partial<HeartbeatConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Record that the user sent a message */
  recordUserActivity(): void {
    this.lastUserMessage = Date.now();
    this.consecutiveFailures = 0;
    this.retryAfter = 0;
    this.paused = false;
    this.lastError = undefined;
  }

  pause(reason: string): void {
    this.paused = true;
    this.lastError = describeHeartbeatError(reason);
  }

  /** Get current activity state based on last user message */
  getActivityState(): ActivityState {
    const sinceLastMsg = Date.now() - this.lastUserMessage;
    const hours = sinceLastMsg / (1000 * 60 * 60);
    if (hours < 1) return 'active';
    if (hours < 4) return 'idle';
    return 'sleeping';
  }

  /** Check if we're in quiet hours right now */
  isQuietHours(): boolean {
    const hour = new Date().getHours();
    const { quietHoursStart, quietHoursEnd } = this.config;
    if (quietHoursStart > quietHoursEnd) {
      // Wraps midnight (e.g. 23:00–08:00)
      return hour >= quietHoursStart || hour < quietHoursEnd;
    }
    return hour >= quietHoursStart && hour < quietHoursEnd;
  }

  /** Get the current heartbeat interval in milliseconds */
  getCurrentInterval(): number {
    const state = this.getActivityState();
    switch (state) {
      case 'active': return this.config.activeIntervalMin * 60_000;
      case 'idle': return this.config.idleIntervalMin * 60_000;
      case 'sleeping': return this.config.sleepingIntervalMin * 60_000;
    }
  }

  /** Should we fire a heartbeat right now? */
  shouldFire(): boolean {
    if (!this.timer || !this.onHeartbeat || this.callbackRunning || this.paused) return false;

    if (this.isQuietHours()) return false;

    if (this.consecutiveFailures > 0) {
      if (Date.now() < this.retryAfter) return false;
    } else if (Date.now() - this.lastHeartbeat < this.getCurrentInterval()) {
      return false;
    }

    return this.config.hasWork?.() === true;
  }

  /** Start the scheduler with a callback */
  start(callback: () => Promise<void>, onError?: (error: unknown) => void): void {
    if (this.timer) return;
    this.onHeartbeat = callback;
    this.onError = onError;
    this.lastUserMessage = Date.now(); // Assume active on start

    this.timer = setInterval(() => { void this.tick(); }, 60_000);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.callbackRunning) return;
    try {
      if (!this.shouldFire()) return;
      this.callbackRunning = true;
      this.lastHeartbeat = Date.now();
      await this.onHeartbeat?.();
      this.consecutiveFailures = 0;
      this.retryAfter = 0;
      if (!this.paused) this.lastError = undefined;
    } catch (error) {
      this.consecutiveFailures++;
      this.lastError = describeHeartbeatError(error);
      if (this.consecutiveFailures >= 3) {
        this.paused = true;
      } else {
        const retryDelayMs = this.consecutiveFailures === 1 ? 5 * 60_000 : 15 * 60_000;
        this.retryAfter = Date.now() + retryDelayMs;
      }
      console.error(`[heartbeat] ${this.paused ? 'Paused after three consecutive failures' : 'Attempt failed'}: ${this.lastError}`);
      try {
        this.onError?.(error);
      } catch (reportingError) {
        console.error('[heartbeat] Could not report scheduler failure:', reportingError);
      }
    } finally {
      this.callbackRunning = false;
    }
  }

  /** Stop the scheduler */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.onHeartbeat = undefined;
    this.onError = undefined;
  }

  /** Get scheduler status */
  status(): {
    activity: ActivityState;
    quietHours: boolean;
    nextHeartbeatIn: number;
    lastUserMsg: number;
    running: boolean;
    paused: boolean;
    consecutiveFailures: number;
    lastError?: string;
  } {
    const interval = this.getCurrentInterval();
    const elapsed = Date.now() - this.lastHeartbeat;
    const retryDelay = this.consecutiveFailures > 0 ? Math.max(0, this.retryAfter - Date.now()) : 0;
    return {
      activity: this.getActivityState(),
      quietHours: this.isQuietHours(),
      nextHeartbeatIn: this.paused ? 0 : this.consecutiveFailures > 0 ? retryDelay : Math.max(0, interval - elapsed),
      lastUserMsg: this.lastUserMessage,
      running: this.callbackRunning,
      paused: this.paused,
      consecutiveFailures: this.consecutiveFailures,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }
}
