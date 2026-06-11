/**
 * Mach6 v2.0.0 — Session Hot Resume
 * 
 * Persists active session state to disk on shutdown (or crash) and
 * restores them on startup. This means:
 * - Gateway restarts don't lose conversation context
 * - Active sessions are automatically re-registered
 * - Pending messages are re-queued
 * 
 * State file: .mach6/sessions/hot-state.json
 * Written on: graceful shutdown (SIGTERM/SIGINT), periodic checkpoint (every 60s)
 * Read on: gateway startup
 * 
 * @since 2.0.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ── Types ──────────────────────────────────────────────────────────────────

export interface HotSessionState {
  /** Session ID */
  sessionId: string;
  /** Channel type (discord, whatsapp, http) */
  channelType: string;
  /** Adapter ID */
  adapterId: string;
  /** Chat ID (channel or DM) */
  chatId: string;
  /** Sender ID of last message */
  lastSenderId?: string;
  /** Last activity timestamp */
  lastActivity: number;
  /** Was there an active turn when shutdown occurred? */
  wasActive: boolean;
  /** Provider name at time of save */
  provider: string;
  /** Model at time of save */
  model: string;
}

export interface HotResumeState {
  /** Timestamp of state save */
  savedAt: number;
  /** Mach6 version that saved the state */
  version: string;
  /** Process ID that saved the state */
  pid: number;
  /** Reason for save (shutdown, checkpoint, crash) */
  reason: 'shutdown' | 'checkpoint' | 'crash';
  /** Active sessions at time of save */
  sessions: HotSessionState[];
  /** Provider that was primary at save time */
  primaryProvider: string;
  /** Model in use */
  primaryModel: string;
}

// ── Hot Resume Manager ─────────────────────────────────────────────────────

export class HotResumeManager {
  private stateFile: string;
  private checkpointTimer: ReturnType<typeof setInterval> | null = null;
  private activeSessions = new Map<string, HotSessionState>();
  private version: string;
  private provider: string;
  private model: string;

  constructor(opts: {
    sessionsDir: string;
    version?: string;
    provider: string;
    model: string;
    checkpointIntervalMs?: number;
  }) {
    this.stateFile = path.join(opts.sessionsDir, 'hot-state.json');
    this.version = opts.version ?? '2.0.0';
    this.provider = opts.provider;
    this.model = opts.model;

    // Periodic checkpoint (every 60s by default)
    const interval = opts.checkpointIntervalMs ?? 60_000;
    this.checkpointTimer = setInterval(() => this.save('checkpoint'), interval);
    if (this.checkpointTimer.unref) this.checkpointTimer.unref();
  }

  // ── Track Sessions ───────────────────────────────────────────────────

  /** Register a session as active (call when a new turn starts) */
  trackSession(state: Omit<HotSessionState, 'lastActivity'>): void {
    this.activeSessions.set(state.sessionId, {
      ...state,
      lastActivity: Date.now(),
    });
  }

  /** Mark a session as inactive (call when turn completes) */
  untrackSession(sessionId: string): void {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      session.wasActive = false;
      session.lastActivity = Date.now();
      // Keep in map for resume — remove only on expiry
    }
  }

  /** Update last activity timestamp */
  touch(sessionId: string): void {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      session.lastActivity = Date.now();
    }
  }

  // ── Save & Restore ──────────────────────────────────────────────────

  /** Save current state to disk */
  save(reason: HotResumeState['reason'] = 'checkpoint'): void {
    try {
      // Clean stale sessions (>24h old)
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      for (const [id, session] of this.activeSessions) {
        if (session.lastActivity < cutoff) {
          this.activeSessions.delete(id);
        }
      }

      const state: HotResumeState = {
        savedAt: Date.now(),
        version: this.version,
        pid: process.pid,
        reason,
        sessions: Array.from(this.activeSessions.values()),
        primaryProvider: this.provider,
        primaryModel: this.model,
      };

      fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
    } catch {
      // Non-fatal — hot resume is best-effort
    }
  }

  /** Restore state from disk. Returns previous sessions or null if no state found. */
  static restore(sessionsDir: string): HotResumeState | null {
    const stateFile = path.join(sessionsDir, 'hot-state.json');
    try {
      if (!fs.existsSync(stateFile)) return null;
      const raw = fs.readFileSync(stateFile, 'utf-8');
      const state = JSON.parse(raw) as HotResumeState;

      // Validate age — don't restore state older than 24h
      if (Date.now() - state.savedAt > 24 * 60 * 60 * 1000) {
        fs.unlinkSync(stateFile);
        return null;
      }

      // Clean up the state file after reading (one-shot restore)
      fs.unlinkSync(stateFile);

      return state;
    } catch {
      return null;
    }
  }

  /** Get sessions that were recently active (within last N minutes) */
  getResumableSessions(previousState: HotResumeState, maxAgeMinutes = 60): HotSessionState[] {
    const cutoff = Date.now() - maxAgeMinutes * 60 * 1000;
    return previousState.sessions.filter(s => s.lastActivity > cutoff);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  /** Shutdown — save final state and stop checkpointing */
  shutdown(): void {
    if (this.checkpointTimer) {
      clearInterval(this.checkpointTimer);
      this.checkpointTimer = null;
    }
    // Mark all tracked sessions as active (they were when we got SIGTERM)
    for (const session of this.activeSessions.values()) {
      session.wasActive = true;
    }
    this.save('shutdown');
  }

  /** Get count of tracked sessions */
  get sessionCount(): number {
    return this.activeSessions.size;
  }
}
