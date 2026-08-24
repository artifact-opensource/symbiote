// Symbiote — Activity-Aware Heartbeat Scheduler (fixes Pain #11)
// Scales frequency based on user activity. Respects quiet hours.

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
  /** Task list checker — return true if there's work to do */
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

  constructor(config?: Partial<HeartbeatConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Record that the user sent a message */
  recordUserActivity(): void {
    this.lastUserMessage = Date.now();
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
    // During quiet hours, skip unless there's urgent work
    if (this.isQuietHours()) return false;

    // Check if enough time has passed
    const interval = this.getCurrentInterval();
    if (Date.now() - this.lastHeartbeat < interval) return false;

    // Skip if no work to do
    if (this.config.hasWork && !this.config.hasWork()) return false;

    return true;
  }

  /** Start the scheduler with a callback */
  start(callback: () => Promise<void>): void {
    this.onHeartbeat = callback;
    this.lastUserMessage = Date.now(); // Assume active on start

    // Check every minute
    this.timer = setInterval(async () => {
      if (this.shouldFire()) {
        this.lastHeartbeat = Date.now();
        try {
          await this.onHeartbeat?.();
        } catch (err) {
          console.error('Heartbeat error:', err);
        }
      }
    }, 60_000);
  }

  /** Stop the scheduler */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Get scheduler status */
  status(): { activity: ActivityState; quietHours: boolean; nextHeartbeatIn: number; lastUserMsg: number } {
    const interval = this.getCurrentInterval();
    const elapsed = Date.now() - this.lastHeartbeat;
    return {
      activity: this.getActivityState(),
      quietHours: this.isQuietHours(),
      nextHeartbeatIn: Math.max(0, interval - elapsed),
      lastUserMsg: this.lastUserMessage,
    };
  }
}
