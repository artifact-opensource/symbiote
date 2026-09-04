// Symbiote — Social Presence Manager v2
// Sustained typing + granular activity states.
//
// Shows what AVA is actually doing during a turn:
// thinking, reading, writing, searching, executing, etc.
//
// Discord: setActivity("Reading files...") + sendTyping() refresh
// WhatsApp: composing indicator refresh (no custom text)

import { ActivityType, type Client as DiscordClient } from 'discord.js';

export interface TypingTarget {
  adapterId: string;
  chatId: string;
}

type TypingFunction = (chatId: string, durationMs?: number) => Promise<void>;
type PauseFunction = (chatId: string) => Promise<void>;

interface ActiveTyping {
  target: TypingTarget;
  interval: ReturnType<typeof setInterval>;
  startedAt: number;
}

// ─── Activity Mapping ──────────────────────────────────────────────────────

export type ActivityState =
  | 'idle'
  | 'thinking'
  | 'reading'
  | 'writing'
  | 'editing'
  | 'executing'
  | 'searching'
  | 'browsing'
  | 'analyzing'
  | 'generating'
  | 'recalling'
  | 'staging'
  | 'spawning'
  | 'speaking'
  | 'listening'
  | 'reacting';

interface ActivityDisplay {
  text: string;
  type: ActivityType;
}

// Map tool names → human-readable activity
const TOOL_ACTIVITY: Record<string, ActivityDisplay> = {
  read:            { text: '📖 Reading files...', type: ActivityType.Custom },
  write:           { text: '✍️ Writing...', type: ActivityType.Custom },
  edit:            { text: '✏️ Editing...', type: ActivityType.Custom },
  exec:            { text: '⚡ Executing...', type: ActivityType.Custom },
  process_start:   { text: '🚀 Launching process...', type: ActivityType.Custom },
  process_poll:    { text: '📊 Checking process...', type: ActivityType.Custom },
  process_kill:    { text: '🛑 Stopping process...', type: ActivityType.Custom },
  process_list:    { text: '📋 Listing processes...', type: ActivityType.Custom },
  image:           { text: '👁️ Analyzing image...', type: ActivityType.Custom },
  web_fetch:       { text: '🌐 Browsing the web...', type: ActivityType.Custom },
  memory_search:   { text: '🧠 Searching memory...', type: ActivityType.Custom },
  comb_recall:     { text: '🧠 Recalling...', type: ActivityType.Custom },
  comb_stage:      { text: '💾 Staging memory...', type: ActivityType.Custom },
  tts:             { text: '🔊 Generating speech...', type: ActivityType.Custom },
  message:         { text: '💬 Sending message...', type: ActivityType.Custom },
  typing:          { text: '💬 Communicating...', type: ActivityType.Custom },
  presence:        { text: '💬 Updating presence...', type: ActivityType.Custom },
  delete_message:  { text: '🗑️ Cleaning up...', type: ActivityType.Custom },
  mark_read:       { text: '👀 Reading messages...', type: ActivityType.Custom },
  spawn:           { text: '🧬 Spawning sub-agent...', type: ActivityType.Custom },
  subagent_status: { text: '🔍 Checking sub-agent...', type: ActivityType.Custom },
};

const THINKING_ACTIVITY: ActivityDisplay = { text: '🤔 Thinking...', type: ActivityType.Custom };
const IDLE_ACTIVITY: ActivityDisplay = { text: process.env.IDLE_EMOJI ?? '🔮', type: ActivityType.Custom };

// ─── Presence Manager ──────────────────────────────────────────────────────

export class PresenceManager {
  private activeTyping = new Map<string, ActiveTyping>();
  private typingFunctions = new Map<string, TypingFunction>();
  private discordClients = new Map<string, DiscordClient>();
  private currentActivity: ActivityDisplay = IDLE_ACTIVITY;
  private activityTimeout: ReturnType<typeof setTimeout> | null = null;

  // How often to refresh typing indicator (ms)
  // WhatsApp composing actually persists ~25s on recipient screen.
  // Discord typing lasts ~10s. We use per-adapter intervals to avoid
  // the "bobbing bubble" effect where frequent refreshes cause the
  // indicator to visually restart on the recipient's screen.
  private defaultRefreshMs = 8000;   // Discord: safe default
  private waRefreshMs = 20000;       // WhatsApp: refresh only near expiry (25s window)

  // Safety: max typing duration to prevent zombie typing (5 min)
  private maxTypingMs = 5 * 60 * 1000;

  /**
   * Register a typing function for an adapter.
   */
  registerAdapter(adapterId: string, typingFn: TypingFunction): void {
    this.typingFunctions.set(adapterId, typingFn);
  }

  /**
   * Register a Discord client for rich presence (activity status).
   */
  registerDiscordClient(adapterId: string, client: DiscordClient): void {
    this.discordClients.set(adapterId, client);
  }

  /**
   * Unregister an adapter (on disconnect).
   */
  unregisterAdapter(adapterId: string): void {
    for (const [key, active] of this.activeTyping) {
      if (active.target.adapterId === adapterId) {
        this.stopTyping(active.target);
      }
    }
    this.typingFunctions.delete(adapterId);
    this.discordClients.delete(adapterId);
  }

  /**
   * Start sustained typing indicator. Refreshes automatically
   * until stopTyping is called or maxTypingMs is reached.
   *
   * WhatsApp: single composing signal, refreshed every ~20s.
   * WhatsApp composing persists ~25s on recipient screen, so
   * refreshing every 20s keeps it alive without visual flicker.
   * Discord: refreshed every ~8s (indicator lasts ~10s).
   */
  startTyping(target: TypingTarget): void {
    const key = `${target.adapterId}:${target.chatId}`;

    // Already typing? Don't restart — avoids flicker from re-sending composing
    if (this.activeTyping.has(key)) {
      return;
    }

    const typingFn = this.typingFunctions.get(target.adapterId);
    if (!typingFn) return;

    // Fire immediately — Infinity tells adapter to skip auto-pause (we handle it in stopTyping)
    typingFn(target.chatId, Infinity).catch(() => {});

    // Set activity to thinking (default state at start of turn)
    this.setActivity(THINKING_ACTIVITY);

    // Pick refresh interval based on adapter type
    const isWhatsApp = target.adapterId.includes('whatsapp');
    const refreshMs = isWhatsApp ? this.waRefreshMs : this.defaultRefreshMs;

    // Set up refresh interval
    const interval = setInterval(() => {
      const active = this.activeTyping.get(key);
      if (!active) return;

      // Safety timeout
      if (Date.now() - active.startedAt > this.maxTypingMs) {
        console.warn(`[presence] Typing timeout for ${key} (>${this.maxTypingMs}ms)`);
        this.stopTyping(target);
        return;
      }

      // Infinity = sustained mode, no auto-pause between refreshes
      typingFn(target.chatId, Infinity).catch(() => {});
    }, refreshMs);

    this.activeTyping.set(key, {
      target,
      interval,
      startedAt: Date.now(),
    });
  }

  /**
   * Stop typing indicator for a target.
   * Sends 'paused' to WhatsApp to cleanly dismiss the composing bubble.
   */
  stopTyping(target: TypingTarget): void {
    const key = `${target.adapterId}:${target.chatId}`;
    const active = this.activeTyping.get(key);
    if (active) {
      clearInterval(active.interval);
      this.activeTyping.delete(key);

      // Send 'paused' to cleanly dismiss the composing indicator
      // Without this, WhatsApp composing lingers for ~25s after we stop refreshing
      const typingFn = this.typingFunctions.get(target.adapterId);
      if (typingFn && target.adapterId.includes('whatsapp')) {
        // Duration 0 = send paused immediately (adapter handles this)
        typingFn(target.chatId, 0).catch(() => {});
      }
    }

    // Return to idle when all typing stops
    if (this.activeTyping.size === 0) {
      this.setActivity(IDLE_ACTIVITY);
    }
  }

  /**
   * Signal that a tool has started executing.
   * Updates Discord activity to reflect what's happening.
   */
  toolStart(toolName: string): void {
    const activity = TOOL_ACTIVITY[toolName] ?? THINKING_ACTIVITY;
    this.setActivity(activity);

    // Clear any pending "back to thinking" timeout
    if (this.activityTimeout) {
      clearTimeout(this.activityTimeout);
      this.activityTimeout = null;
    }
  }

  /**
   * Signal that a tool has finished executing.
   * Returns to "Thinking..." after a brief delay (the LLM processes next).
   */
  toolEnd(_toolName: string): void {
    // Brief delay before going back to thinking — avoids flickering
    // if another tool starts immediately
    if (this.activityTimeout) clearTimeout(this.activityTimeout);
    this.activityTimeout = setTimeout(() => {
      // Only go back to thinking if we're still in an active turn
      if (this.activeTyping.size > 0) {
        this.setActivity(THINKING_ACTIVITY);
      }
      this.activityTimeout = null;
    }, 300);
  }

  /**
   * Signal the LLM is streaming (between tool calls).
   */
  llmStreaming(): void {
    if (this.activityTimeout) clearTimeout(this.activityTimeout);
    this.setActivity(THINKING_ACTIVITY);
  }

  /**
   * Stop all active typing (shutdown).
   */
  stopAll(): void {
    for (const [, active] of this.activeTyping) {
      clearInterval(active.interval);
    }
    this.activeTyping.clear();
    if (this.activityTimeout) {
      clearTimeout(this.activityTimeout);
      this.activityTimeout = null;
    }
    this.setActivity(IDLE_ACTIVITY);
  }

  /**
   * Get stats for monitoring.
   */
  stats(): { activeCount: number; adapters: number; currentActivity: string } {
    return {
      activeCount: this.activeTyping.size,
      adapters: this.typingFunctions.size,
      currentActivity: this.currentActivity.text,
    };
  }

  // ── Internal ─────────────────────────────────────────────────────────

  private setActivity(activity: ActivityDisplay): void {
    if (this.currentActivity.text === activity.text) return; // no-op for same state
    this.currentActivity = activity;

    // Update all registered Discord clients
    for (const [, client] of this.discordClients) {
      try {
        if (activity.text === IDLE_ACTIVITY.text) {
          // Clear to just the crystal ball
          client.user?.setActivity('🔮', { type: ActivityType.Custom });
        } else {
          client.user?.setActivity(activity.text, { type: ActivityType.Custom });
        }
      } catch (err) {
        // Ignore — client might not be ready
      }
    }
  }
}

// Singleton — one presence manager for the entire gateway
export const presenceManager = new PresenceManager();
