// Symbiote — Social Presence Manager v2
// Sustained typing + granular activity states.
//
// Shows what the agent is doing during a turn:
// thinking, reading, writing, searching, executing, etc.
//
// Discord: setActivity("Reading files...") + sendTyping() refresh
// WhatsApp: composing indicator refresh (no custom text)

import { ActivityType, Events, type Client as DiscordClient } from 'discord.js';
import { TOOL_EMOJI } from './progress-bubble.js';

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

interface TurnActivity {
  activity: ActivityDisplay;
  isTool: boolean;
  sequence: number;
}

// ─── Activity Mapping ──────────────────────────────────────────────────────

export type ActivityState =
  | 'idle'
  | 'thinking'
  | 'reasoning'
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
  process_kill:   { text: '🛑 Stopping process...', type: ActivityType.Custom },
  process_list:   { text: '📋 Listing processes...', type: ActivityType.Custom },
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
const REASONING_ACTIVITY: ActivityDisplay = { text: '🧩 Reasoning...', type: ActivityType.Custom };
const WRITING_ACTIVITY: ActivityDisplay = { text: '✍️ Writing response...', type: ActivityType.Custom };
const IDLE_ACTIVITY: ActivityDisplay = { text: process.env.IDLE_EMOJI ?? '', type: ActivityType.Custom };

// ─── Presence Manager ──────────────────────────────────────────────────────

export class PresenceManager {
  private activeTyping = new Map<string, ActiveTyping>();
  private activeTurns = new Map<string, TurnActivity>();
  private typingFunctions = new Map<string, TypingFunction>();
  private discordClients = new Map<string, DiscordClient>();
  private currentActivity: ActivityDisplay = IDLE_ACTIVITY;
  private activityTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private activitySequence = 0;

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
    client.on(Events.ShardResume, () => this.applyActivity(client));
    client.once(Events.ClientReady, () => this.applyActivity(client));
    if (client.isReady()) this.applyActivity(client);
  }

  beginTurn(target: TypingTarget): void {
    this.updateTurnActivity(target, THINKING_ACTIVITY, false);
  }

  endTurn(target: TypingTarget): void {
    this.stopTyping(target, false);
    this.clearActivityTimeout(target);
    this.activeTurns.delete(this.turnKey(target));
    this.refreshActivity();
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
    for (const key of this.activeTurns.keys()) {
      if (key.startsWith(`${adapterId}:`)) {
        const timer = this.activityTimeouts.get(key);
        if (timer) clearTimeout(timer);
        this.activityTimeouts.delete(key);
        this.activeTurns.delete(key);
      }
    }
    this.typingFunctions.delete(adapterId);
    this.discordClients.delete(adapterId);
    this.refreshActivity();
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
  stopTyping(target: TypingTarget, resetActivity = true): void {
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
    if (resetActivity && this.activeTyping.size === 0) {
      this.setActivity(IDLE_ACTIVITY);
    }
  }

  /**
   * Signal that a tool has started executing.
   * Updates Discord activity to reflect what's happening.
   */
  toolStart(target: TypingTarget, toolName: string): void {
    this.clearActivityTimeout(target);
    const activity = TOOL_ACTIVITY[toolName] ?? {
      text: `${TOOL_EMOJI[toolName] ?? '🧰'} Using ${toolName.replaceAll('_', ' ')}...`,
      type: ActivityType.Custom,
    };
    this.updateTurnActivity(target, activity, true);
  }

  /**
   * Signal that a tool has finished executing.
   * Returns to "Thinking..." after a brief delay (the LLM processes next).
   */
  toolEnd(target: TypingTarget, _toolName: string): void {
    const key = this.turnKey(target);
    this.clearActivityTimeout(target);
    const current = this.activeTurns.get(key);
    if (!current) return;
    const completedSequence = current.sequence;
    const timer = setTimeout(() => {
      this.activityTimeouts.delete(key);
      const active = this.activeTurns.get(key);
      if (active?.sequence === completedSequence) {
        this.updateTurnActivity(target, THINKING_ACTIVITY, false);
      }
    }, 300);
    this.activityTimeouts.set(key, timer);
  }

  /**
   * Signal the current LLM stream activity without exposing streamed content.
   */
  llmStreaming(target: TypingTarget, state: 'thinking' | 'reasoning' | 'writing' | 'idle' = 'thinking'): void {
    this.clearActivityTimeout(target);
    const activity = state === 'reasoning'
      ? REASONING_ACTIVITY
      : state === 'writing'
        ? WRITING_ACTIVITY
        : state === 'idle'
          ? IDLE_ACTIVITY
          : THINKING_ACTIVITY;
    this.updateTurnActivity(target, activity, false);
  }

  /**
   * Stop all active typing (shutdown).
   */
  stopAll(): void {
    for (const [, active] of this.activeTyping) {
      clearInterval(active.interval);
    }
    this.activeTyping.clear();
    this.activeTurns.clear();
    for (const timer of this.activityTimeouts.values()) clearTimeout(timer);
    this.activityTimeouts.clear();
    this.setActivity(IDLE_ACTIVITY);
  }

  /**
   * Get stats for monitoring.
   */
  stats(): { activeCount: number; adapters: number; currentActivity: string } {
    return {
      activeCount: this.activeTurns.size,
      adapters: this.typingFunctions.size,
      currentActivity: this.currentActivity.text,
    };
  }

  // ── Internal ─────────────────────────────────────────────────────────

  private setActivity(activity: ActivityDisplay): void {
    if (this.currentActivity.text === activity.text) return; // no-op for same state
    this.currentActivity = activity;

    // Update all registered Discord clients
    for (const [, client] of this.discordClients) this.applyActivity(client);
  }

  private turnKey(target: TypingTarget): string {
    return `${target.adapterId}:${target.chatId}`;
  }

  private clearActivityTimeout(target: TypingTarget): void {
    const key = this.turnKey(target);
    const timer = this.activityTimeouts.get(key);
    if (timer) clearTimeout(timer);
    this.activityTimeouts.delete(key);
  }

  private updateTurnActivity(target: TypingTarget, activity: ActivityDisplay, isTool: boolean): void {
    const key = this.turnKey(target);
    this.clearActivityTimeout(target);
    this.activeTurns.set(key, { activity, isTool, sequence: ++this.activitySequence });
    this.refreshActivity();
  }

  private refreshActivity(): void {
    let selected: TurnActivity | undefined;
    for (const turn of this.activeTurns.values()) {
      const rank = turn.isTool ? 3
        : turn.activity.text === WRITING_ACTIVITY.text ? 2
          : turn.activity.text === REASONING_ACTIVITY.text ? 1
            : 0;
      const selectedRank = selected
        ? selected.isTool ? 3
          : selected.activity.text === WRITING_ACTIVITY.text ? 2
            : selected.activity.text === REASONING_ACTIVITY.text ? 1
              : 0
        : -1;
      if (!selected || rank > selectedRank || (rank === selectedRank && turn.sequence > selected.sequence)) {
        selected = turn;
      }
    }
    this.setActivity(selected?.activity ?? IDLE_ACTIVITY);
  }

  private applyActivity(client: DiscordClient): void {
    if (!client.isReady() || !client.user) return;
    try {
      // Discord bots cannot publish user-style Custom Status activities.
      // A normal Playing activity is supported and remains visible in the member list.
      if (!this.currentActivity.text) {
        const status = client.user.presence.status;
        client.user.setPresence({ activities: [], status: status === 'offline' ? 'online' : status });
        return;
      }
      client.user.setActivity(this.currentActivity.text, { type: ActivityType.Playing });
    } catch (error) {
      console.error('[presence] Discord activity update failed:', error);
    }
  }
}

// Singleton — one presence manager for the entire gateway
export const presenceManager = new PresenceManager();
