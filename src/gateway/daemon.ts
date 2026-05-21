/**
 * Symbiote — Gateway Daemon
 * 
 * The persistent process. Manages channel lifecycle, agent sessions,
 * signal handling, graceful shutdown, and hot-reload.
 * 
 * Symbiote AI Gateway — persistent engine.
 */
import 'dotenv/config';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-ignore — no types for qrcode-terminal
import qrcode from 'qrcode-terminal';

// Voice middleware — auto-transcribe inbound voice notes, generate voice replies
import { processVoiceInbound, generateVoiceReply, cleanupVoiceFile } from '../voice/voice-middleware.js';
// Use global process (don't import — it shadows signal handlers)
import {
  palette, gradient, versionBanner, kvLine, ok, warn, info,
  divider, thickDivider, sectionHeader,
} from '../cli/brand.js';
import { ChannelRegistry } from '../channels/registry.js';
import { DiscordAdapter } from '../channels/adapters/discord.js';
import { WhatsAppAdapter } from '../channels/adapters/whatsapp.js';
import { ToolRegistry } from '../tools/registry.js';
import { presenceManager } from '../channels/presence.js';
import { HeartbeatScheduler } from '../heartbeat/scheduler.js';
import { readTool } from '../tools/builtin/read.js';
import { writeTool } from '../tools/builtin/write.js';
import { execTool } from '../tools/builtin/exec.js';
import { editTool } from '../tools/builtin/edit.js';
import { imageTool } from '../tools/builtin/image.js';
import {
  processStartTool,
  processPollTool,
  processKillTool,
  processListTool,
} from '../tools/builtin/process.js';
import { ttsTool } from '../tools/builtin/tts.js';
import { webFetchTool } from '../tools/builtin/web-fetch.js';
import { memorySearchTool } from '../tools/builtin/memory.js';
import { combRecallTool, combStageTool, setCombVdbHook, flushMessages } from '../tools/builtin/comb.js';
import { vdbSearchTool, vdbIngestTool, vdbStatsTool } from '../tools/builtin/memory-vdb.js';
import { webBrowseTool, webClickTool, webTypeTool, webScreenshotTool, webExtractTool, webScrollTool, webWaitTool, webSessionTool, webTabOpenTool, webTabSwitchTool, webTabCloseTool, webTabsTool, webDownloadTool, webUploadTool } from '../tools/builtin/web-browser.js';
import { createSpawnTool, createSubAgentStatusTool } from '../tools/builtin/spawn.js';
import { SubAgentManager } from '../sessions/sub-agent.js';
import { createMessageTool, createTypingTool, createPresenceTool, createDeleteMessageTool, createMarkReadTool } from '../tools/builtin/message.js';
import { SessionManager } from '../sessions/manager.js';
import { buildSystemPrompt } from '../agent/system-prompt.js';
import { runAgent } from '../agent/runner.js';
import { ContextMonitor } from '../agent/context-monitor.js';
import { ContextStore } from '../agent/context-store.js';
import { PulseBudgetManager } from '../agent/pulse.js';
import { BlinkController } from '../agent/blink.js';
import { loadConfig, type SymbioteConfig } from '../config/config.js';
import type { Provider, ProviderConfig } from '../providers/types.js';
import { anthropicProvider } from '../providers/anthropic.js';
import { openaiProvider } from '../providers/openai.js';
import { githubCopilotProvider } from '../providers/github-copilot.js';
import { geminiProvider } from '../providers/gemini.js';
import { gladiusProvider } from '../providers/gladius.js';
import { groqProvider } from '../providers/groq.js';
import { ollamaProvider } from '../providers/ollama.js';
import { xaiProvider } from '../providers/xai.js';
import type { BusEnvelope, ChannelPolicy, OutboundMessage } from '../channels/types.js';
import { formatForChannel } from '../channels/formatter.js';
import { createSandboxedRegistry, type SessionContext } from '../tools/sandbox.js';
import { HttpApiServer, type ChatRequest, type ChatResponse } from '../web/http-api.js';
import { startWebServer } from '../web/server.js';
import { McpBridge } from '../tools/mcp-bridge.js';
import { MetricsCollector, getMetrics } from '../metrics/collector.js';
import { HotResumeManager } from '../sessions/hot-resume.js';
import { ProviderHealthMonitor } from '../providers/health.js';

// ─── Types ─────────────────────────────────────────────────────────────────

interface DiscordChannelConfig {
  enabled: boolean;
  token: string;
  botId?: string;
  /** Adapter ID — must be unique per bot instance (default: 'discord-main') */
  adapterId?: string;
  policy?: Partial<ChannelPolicy>;
  /** Override workspace files for system prompt (multi-persona) */
  promptFiles?: { path: string; label: string }[];
}

interface GatewayConfig {
  /** Path to mach6.json */
  configPath?: string;
  /** Channels to enable */
  channels?: {
    discord?: DiscordChannelConfig;
    whatsapp?: {
      enabled: boolean;
      authDir: string;
      phoneNumber?: string;
      autoRead?: boolean;
      policy?: Partial<ChannelPolicy>;
    };
  };
  /** Additional Discord bot instances (multi-bot support) */
  discordExtra?: DiscordChannelConfig[];
  /** Owner IDs across all channels */
  ownerIds?: string[];
  /** HTTP API port */
  apiPort?: number;
  /** Web UI port */
  webPort?: number;
  /** Web UI host (default 127.0.0.1, use 0.0.0.0 for LAN access) */
  webHost?: string;
}

interface ActiveTurn {
  sessionId: string;
  abortController: AbortController;
  startedAt: number;
  channelType: string;
  chatId: string;
  adapterId: string;
}

// ─── Provider Registry ─────────────────────────────────────────────────────

const PROVIDERS = new Map<string, Provider>([
  ['anthropic', anthropicProvider],
  ['openai', openaiProvider],
  ['github-copilot', githubCopilotProvider],
  ['gemini', geminiProvider],
  ['gladius', gladiusProvider],
  ['groq', groqProvider],
  ['ollama', ollamaProvider],
  ['xai', xaiProvider],
]);

// ─── Gateway ───────────────────────────────────────────────────────────────

export class SymbioteGateway {
  private config: SymbioteConfig;
  private gatewayConfig: GatewayConfig;
  private channelRegistry: ChannelRegistry;
  private toolRegistry: ToolRegistry;
  private sessionManager: SessionManager;
  private activeTurns = new Map<string, ActiveTurn>();
  private provider: Provider;
  private providerName: string;
  private model: string;
  private systemPrompt: string;
  private shutdownRequested = false;
  private heartbeat: HeartbeatScheduler;
  private subAgentManager: SubAgentManager;
  private pulseBudget: PulseBudgetManager;
  private startTime = Date.now();
  private httpApi: HttpApiServer | null = null;
  private webServer: import('node:http').Server | null = null;
  private mcpBridges: McpBridge[] = [];
  /** Per-adapter system prompt file overrides (adapterId → file list) */
  private adapterPromptFiles = new Map<string, { path: string; label: string }[]>();
  /** Fallback provider chain — tried in order if primary fails */
  private fallbackChain: { name: string; provider: Provider }[] = [];
  /** Context monitor — proactive context management (warn/compact/emergency) */
  private contextMonitor: ContextMonitor;
  /** VDB Pulse — real-time memory indexing every 5s */
  private vdbWatermarks = new Map<string, number>();
  private vdbPulseTimer: ReturnType<typeof setInterval> | null = null;
  private vdbInstance: import('../memory/vdb.js').VectorDB | null = null;
  /** Context Store — bridges attention (context window) and memory (vdb) */
  private contextStore: ContextStore | null = null;

  /** v2.0 — Metrics collector: tokens, latency, tools, errors */
  private metrics: MetricsCollector;
  /** v2.0 — Hot resume: persist and restore session state across restarts */
  private hotResume: HotResumeManager;
  /** v2.0 — Provider health: circuit breaker, latency tracking, health states */
  private providerHealth: ProviderHealthMonitor;

  constructor(gatewayConfig: GatewayConfig) {
    this.gatewayConfig = gatewayConfig;
    this.config = loadConfig(gatewayConfig.configPath);

    // Set cwd to workspace so tools resolve relative paths correctly
    if (this.config.workspace) {
      process.chdir(this.config.workspace);
      process.env.MACH6_WORKSPACE = this.config.workspace;
    console.log(`${palette.dim}  [gateway]${palette.reset} Working directory: ${palette.cyan}${this.config.workspace}${palette.reset}`);
    }

    // Provider
    this.providerName = this.config.defaultProvider;
    this.provider = PROVIDERS.get(this.providerName)!;
    if (!this.provider) {
      throw new Error(`Unknown provider: ${this.providerName}`);
    }
    this.model = this.config.defaultModel;

    // Build fallback provider chain
    if (this.config.fallbackProviders?.length) {
      for (const fbName of this.config.fallbackProviders) {
        const fbProvider = PROVIDERS.get(fbName);
        if (fbProvider) {
          this.fallbackChain.push({ name: fbName, provider: fbProvider });
        } else {
          console.warn(`[config] Fallback provider '${fbName}' not found — skipping`);
        }
      }
    }

    // Tools (can be disabled via config: "tools": { "enabled": false })
    this.toolRegistry = new ToolRegistry();
    const toolsEnabled = (this.gatewayConfig as any).tools?.enabled !== false;
    if (toolsEnabled) {
      for (const tool of [
        readTool, writeTool, editTool, execTool, imageTool,
        processStartTool, processPollTool, processKillTool, processListTool,
        ttsTool, webFetchTool, memorySearchTool, combRecallTool, combStageTool,
        vdbSearchTool, vdbIngestTool, vdbStatsTool,
        webBrowseTool, webClickTool, webTypeTool, webScreenshotTool, webExtractTool,
        webScrollTool, webWaitTool, webSessionTool, webTabOpenTool, webTabSwitchTool,
        webTabCloseTool, webTabsTool, webDownloadTool, webUploadTool,
      ]) {
        this.toolRegistry.register(tool);
      }
    } else {
      console.log(`${palette.dim}  [gateway]${palette.reset} Tools ${palette.yellow}disabled${palette.reset} via config`);
    }

    // Heartbeat scheduler
    const hbConfig = (this.gatewayConfig as any).heartbeat ?? {};
    this.heartbeat = new HeartbeatScheduler({
      activeIntervalMin: hbConfig.activeIntervalMin ?? 30,
      idleIntervalMin: hbConfig.idleIntervalMin ?? 120,
      sleepingIntervalMin: hbConfig.sleepingIntervalMin ?? 360,
      quietHoursStart: hbConfig.quietHoursStart ?? 23,
      quietHoursEnd: hbConfig.quietHoursEnd ?? 8,
    });

    // Sessions
    this.sessionManager = new SessionManager(this.config.sessionsDir);

    // v2.0 — Metrics collector
    this.metrics = getMetrics({
      metricsDir: path.join(this.config.sessionsDir ?? '.sessions', 'metrics'),
      version: '2.0.0',
    });

    // v2.0 — Provider health monitor (circuit breaker + latency tracking)
    this.providerHealth = new ProviderHealthMonitor();

    // v2.0 — Hot resume manager (session state persistence across restarts)
    this.hotResume = new HotResumeManager({
      sessionsDir: this.config.sessionsDir ?? '.sessions',
      version: '2.0.0',
      provider: this.providerName,
      model: this.model,
    });

    // Context Monitor — proactive context management
    // Thresholds: warn 65%, compact 75%, emergency 88%
    const ws = this.config.workspace;
    this.contextMonitor = new ContextMonitor({
      maxContextTokens: 180_000,  // ~200K context, leave headroom
      warnThreshold: 0.65,
      compactThreshold: 0.75,
      emergencyThreshold: 0.88,
      transcriptDir: path.join(ws || '.', '.sessions', 'transcripts'),
      onCombStage: async (content: string) => {
        try {
          if (this.vdbInstance) {
            this.vdbInstance.index({
              id: '', text: content.length > 2000 ? content.slice(0, 2000) : content,
              source: 'context-monitor', role: 'context', timestamp: Date.now(),
            });
          }
        } catch (e) {
          console.error('[context-monitor] COMB stage failed:', e);
        }
      },
    });

    // System prompt (base — rebuilt per-message with channel context)
    this.systemPrompt = buildSystemPrompt({
      workspace: this.config.workspace,
      tools: this.toolRegistry.list().map(t => t.name),
    });
    console.log(`${palette.dim}  [gateway]${palette.reset} System prompt: ${palette.silver}${this.systemPrompt.length} chars${palette.reset}`);

    // Channel registry
    this.channelRegistry = new ChannelRegistry({
      globalOwnerIds: gatewayConfig.ownerIds,
      onAdapterHealthChange: (id, health) => {
        console.log(`${palette.dim}  [gateway]${palette.reset} Adapter ${palette.cyan}${id}${palette.reset}: ${palette.silver}${health.state}${palette.reset}${health.lastError ? ` ${palette.dim}(${health.lastError})${palette.reset}` : ''}`);
      },
    });

    // Register message tool (needs channelRegistry — must come after registry creation)
    if (toolsEnabled) {
      this.toolRegistry.register(createMessageTool(this.channelRegistry));
      this.toolRegistry.register(createTypingTool(this.channelRegistry));
      this.toolRegistry.register(createPresenceTool(this.channelRegistry));
      this.toolRegistry.register(createDeleteMessageTool(this.channelRegistry));
      this.toolRegistry.register(createMarkReadTool(this.channelRegistry));
    }

    // Sub-agent manager + spawn tools
    this.subAgentManager = new SubAgentManager(this.sessionManager);
    this.pulseBudget = new PulseBudgetManager(this.config.sessionsDir ?? '.sessions');
    const provCfg = (this.config.providers as Record<string, any>)[this.providerName] ?? {};
    const spawnProvConfig = {
      model: this.model,
      maxTokens: this.config.maxTokens,
      temperature: this.config.temperature,
      ...provCfg,
    };
    if (toolsEnabled) {
      this.toolRegistry.register(createSpawnTool(
        this.subAgentManager, this.provider, spawnProvConfig, this.toolRegistry, this.config.workspace
      ));
      this.toolRegistry.register(createSubAgentStatusTool(this.subAgentManager));
    }

    // Rebuild system prompt now that all tools are registered
    this.systemPrompt = buildSystemPrompt({
      workspace: this.config.workspace,
      tools: this.toolRegistry.list().map(t => t.name),
    });
  }

  // ── Start ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    console.log(versionBanner('2.0.0'));

    const gatewayTitle = gradient('SYMBIOTE', [138, 43, 226], [0, 229, 255]);
    console.log(`  ${palette.bold}${gatewayTitle}${palette.reset}`);
    console.log();
    console.log(kvLine('Provider', `${palette.cyan}${this.providerName}${palette.reset}${palette.dim}/${palette.reset}${palette.white}${this.model}${palette.reset}`));
    if (this.fallbackChain.length > 0) {
      const fbNames = this.fallbackChain.map(fb => `${palette.yellow}${fb.name}${palette.reset}`).join(` ${palette.dim}→${palette.reset} `);
      console.log(kvLine('Fallback', fbNames));
    }
    console.log(kvLine('Tools', `${palette.gold}${this.toolRegistry.list().length}${palette.reset} ${palette.dim}registered${palette.reset}`));
    console.log(kvLine('Workspace', `${palette.cyan}${this.config.workspace}${palette.reset}`));
    console.log(kvLine('PID', `${palette.dim}${process.pid}${palette.reset}`));
    console.log();
    console.log(divider());

    // Connect MCP servers (external tool sources)
    await this.connectMcpServers();

    // Register signal handlers
    this.setupSignals();

    // Subscribe to bus messages
    const bus = this.channelRegistry.getBus();
    this.startMessageLoop();

    // Start channels
    await this.startChannels();

    // Start HTTP API server
    await this.startHttpApi();

    // Start Web UI server (bound to 0.0.0.0 for LAN access)
    this.startWebUi();

    // Start VDB real-time memory pulse (5s incremental indexing)
    this.startVdbPulse();

    // v2.0 — Hot Resume: restore previous session state
    this.restoreHotState();

    const elapsed = Date.now() - this.startTime;
    console.log();
    console.log(divider());
    const readyMsg = gradient('SYMBIOTE READY', [0, 230, 118], [0, 188, 212]);
    console.log(`  ${palette.bold}${palette.green}⚡${palette.reset} ${palette.bold}${readyMsg}${palette.reset} ${palette.dim}— ${elapsed}ms${palette.reset}`);
    console.log();
  }


  // ── v2.0 Hot Resume ──────────────────────────────────────────────────

  private restoreHotState(): void {
    try {
      const state = HotResumeManager.restore(this.config.sessionsDir ?? '.sessions');
      if (!state) return;
      
      const resumable = this.hotResume.getResumableSessions(state, 60);
      if (resumable.length > 0) {
        console.log(`${palette.dim}  [hot-resume]${palette.reset} Restored ${resumable.length} session(s) from previous run (${state.reason})`);
        for (const s of resumable) {
          console.log(`${palette.dim}    → ${s.sessionId} (${s.channelType}/${s.chatId})${palette.reset}`);
        }
      }
    } catch {
      // Non-fatal — hot resume is best-effort
    }
  }

  // ── VDB Pulse — Real-time memory indexing ────────────────────────────

  /** Start VDB pulse — indexes new messages every 5 seconds */
  private startVdbPulse(): void {
    const VDB_PULSE_MS = 5_000;

    this.vdbPulseTimer = setInterval(() => {
      if (this.shutdownRequested) return;
      this.vdbPulseFlush().catch(() => { /* non-fatal */ });
    }, VDB_PULSE_MS);

    // Dont block process exit
    if (this.vdbPulseTimer.unref) this.vdbPulseTimer.unref();
    console.log(`${palette.dim}  [vdb]${palette.reset} Pulse active — indexing every ${VDB_PULSE_MS / 1000}s`);

    // Initialize Context Store with vdb
    this.initContextStore().catch(err => {
      console.error(`${palette.dim}  [context-store]${palette.reset} Init failed:`, err);
    });
  }

  /** Initialize the Context Store — bridges context window and vdb memory */
  private async initContextStore(): Promise<void> {
    if (!this.vdbInstance) {
      const { VectorDB } = await import("../memory/vdb.js");
      this.vdbInstance = new VectorDB(process.env.MACH6_WORKSPACE ?? process.cwd());
    }
    this.contextStore = new ContextStore(this.vdbInstance, {
      retrievalK: 5,
      retrievalThreshold: 0.15,
      retrievalBudget: 3000,
      queryDepth: 3,
      sessionSource: 'session',
      sessionId: 'main',
    });

    // Boot ingestion — load identity files into vdb for retrieval
    const ws = this.config.workspace || process.cwd();
    const bootFiles = [
      'SOUL.md', 'IDENTITY.md', 'AGENTS.md', 'BOOTSTRAP.md', 'TOOLS.md',
    ];
    const texts: Array<{ text: string; source: string }> = [];
    for (const f of bootFiles) {
      const fp = path.join(ws, f);
      try {
        if (fs.existsSync(fp)) {
          texts.push({ text: fs.readFileSync(fp, 'utf-8'), source: f });
        }
      } catch { /* skip */ }
    }

    // Also load today's and yesterday's memory files
    const now = new Date();
    for (let d = 0; d < 2; d++) {
      const date = new Date(now.getTime() - d * 86400000);
      const dateStr = date.toISOString().split('T')[0];
      const memFile = path.join(ws, 'memory', `${dateStr}.md`);
      try {
        if (fs.existsSync(memFile)) {
          texts.push({ text: fs.readFileSync(memFile, 'utf-8'), source: `memory/${dateStr}` });
        }
      } catch { /* skip */ }
    }

    if (texts.length > 0) {
      this.contextStore.ingestBoot(texts);
    }

    // Wire COMB→VDB: stage indexes into VDB, recall queries VDB
    const vdb = this.vdbInstance!;
    setCombVdbHook(
      // indexFn
      (text: string, source: string) => {
        vdb.index({
          id: '', text: text.length > 2000 ? text.slice(0, 2000) : text,
          source, role: 'context', timestamp: Date.now(), sessionId: 'comb',
        });
      },
      // recentFn
      (source: string, k: number) => vdb.recent(source, k),
    );

    console.log(`${palette.dim}  [context-store]${palette.reset} ${palette.green}Ready${palette.reset} — memory retrieval active, COMB→VDB wired`);
  }

  /** Flush new messages from all active sessions to VDB */
  private async vdbPulseFlush(): Promise<void> {
    try {
      // Lazy-init VDB
      if (!this.vdbInstance) {
        const { VectorDB } = await import("../memory/vdb.js");
        this.vdbInstance = new VectorDB(process.env.MACH6_WORKSPACE ?? process.cwd());
      }

      const sessions = this.sessionManager.list();
      let totalIndexed = 0;

      for (const summary of sessions) {
        // Only process sessions with new messages since last flush
        const watermark = this.vdbWatermarks.get(summary.id) ?? 0;
        if (summary.messageCount <= watermark) continue;

        const session = this.sessionManager.load(summary.id);
        if (!session) continue;

        // Index only messages after the watermark
        const newMessages = session.messages.slice(watermark);
        let indexed = 0;

        for (const msg of newMessages) {
          if (msg.role === "system") continue;
          if (msg.role === "tool") continue;
          if ((msg as any).tool_calls?.length) continue;
          const text = typeof msg.content === "string" ? msg.content?.trim() : "";
          if (!text || text.length < 15) continue;

          let source = "session";
          if (summary.id.includes("whatsapp") || summary.id.includes("@")) source = "whatsapp";
          else if (summary.id.includes("discord")) source = "discord";
          else if (summary.id.includes("http") || summary.id.includes("web")) source = "webchat";

          const indexText = text.length > 2000 ? text.slice(0, 2000) : text;
          const wasIndexed = this.vdbInstance.index({
            id: "",
            text: indexText,
            source,
            role: msg.role,
            timestamp: Date.now(),
            sessionId: summary.id,
          });
          if (wasIndexed) indexed++;
        }

        this.vdbWatermarks.set(summary.id, session.messages.length);
        totalIndexed += indexed;
      }

      if (totalIndexed > 0) {
        console.log(`${palette.dim}  [vdb]${palette.reset} Pulse: +${totalIndexed} memories indexed`);
      }

      this.vdbInstance.checkIdle();
    } catch {
      // Non-fatal — VDB pulse is best-effort
    }
  }

  /** Stop VDB pulse */
  private stopVdbPulse(): void {
    if (this.vdbPulseTimer) {
      clearInterval(this.vdbPulseTimer);
      this.vdbPulseTimer = null;
    }
    if (this.vdbInstance) {
      this.vdbInstance.evict();
      this.vdbInstance = null;
    }
  }
  // ── MCP Servers ────────────────────────────────────────────────────────

  private async connectMcpServers(): Promise<void> {
    const mcpConfig = (this.gatewayConfig as any).mcpServers;
    if (!mcpConfig || typeof mcpConfig !== 'object') {
      console.log(info(`MCP: no servers configured`));
      return;
    }

    const entries = Object.entries(mcpConfig) as [string, { command: string[]; args?: string[]; cwd?: string; env?: Record<string, string>; enabled?: boolean }][];
    const enabled = entries.filter(([_, cfg]) => cfg.enabled !== false);

    if (enabled.length === 0) {
      console.log(info(`MCP: no enabled servers`));
      return;
    }

    console.log(info(`MCP: connecting to ${palette.white}${enabled.length}${palette.reset} server(s)...`));

    for (const [name, cfg] of enabled) {
      try {
        const command = [...(cfg.command ?? []), ...(cfg.args ?? [])];
        const bridge = new McpBridge({
          command,
          cwd: cfg.cwd ?? this.config.workspace,
          env: cfg.env,
          timeout: 30000,
        });

        await bridge.connect();

        // Register all discovered tools into Symbiote's registry
        const tools = bridge.getTools();
        for (const tool of tools) {
          this.toolRegistry.register(tool);
        }
        this.mcpBridges.push(bridge);

        console.log(ok(`MCP: ${palette.cyan}${name}${palette.reset} — ${tools.length} tools`));
      } catch (err) {
        console.log(warn(`MCP: ${name} — ${err instanceof Error ? err.message : err}`));
        // Non-fatal — other servers + builtins still work
      }
    }

    // Rebuild system prompt with new tools
    if (this.mcpBridges.length > 0) {
      this.systemPrompt = buildSystemPrompt({
        workspace: this.config.workspace,
        tools: this.toolRegistry.list().map(t => t.name),
      });
      console.log(ok(`MCP: system prompt rebuilt (${palette.gold}${this.toolRegistry.list().length}${palette.reset} total tools)`));
    }
  }

  // ── Channel Setup ──────────────────────────────────────────────────────

  private async startChannels(): Promise<void> {
    const channels = this.gatewayConfig.channels;
    if (!channels) return;

    // ── Discord adapters (supports multiple bot instances) ─────────────
    // Collect all Discord configs: primary + extras
    const discordConfigs: DiscordChannelConfig[] = [];
    if (channels.discord?.enabled) {
      discordConfigs.push(channels.discord);
    }
    if (this.gatewayConfig.discordExtra?.length) {
      for (const extra of this.gatewayConfig.discordExtra) {
        if (extra.enabled) discordConfigs.push(extra);
      }
    }

    for (const dcfg of discordConfigs) {
      const adapterId = dcfg.adapterId ?? 'discord-main';
      try {
        console.log(info(`Starting Discord adapter ${palette.cyan}${adapterId}${palette.reset}...`));
        const adapter = new DiscordAdapter(adapterId);
        // Day 21 — Mention-Only Protocol: one rule for all bots.
        // Process message only if it @mentions this bot's ID (or is a DM).
        const policy: ChannelPolicy = {
          dmPolicy: 'open',
          groupPolicy: 'mention-only', // kept for type compat, router ignores it
          ownerIds: this.gatewayConfig.ownerIds ?? [],
          selfId: dcfg.botId, // Required for mention detection
          ...dcfg.policy,
        };

        await this.channelRegistry.register(
          adapter,
          { token: dcfg.token, botId: dcfg.botId },
          policy,
        );
        console.log(ok(`Discord ${palette.cyan}${adapterId}${palette.reset} ${palette.green}connected${palette.reset}`));
        presenceManager.registerAdapter(adapterId, (chatId, durationMs) => adapter.typing(chatId, durationMs));
        // Register Discord client for rich activity presence
        const discordClient = adapter.getClient();
        if (discordClient) presenceManager.registerDiscordClient(adapterId, discordClient);
        // Store per-adapter prompt file overrides
        if (dcfg.promptFiles?.length) {
          this.adapterPromptFiles.set(adapterId, dcfg.promptFiles);
        }
      } catch (err) {
        console.log(warn(`Discord ${adapterId} failed — ${(err as Error).message}`));
      }
    }

    // WhatsApp (non-fatal — log and continue if it fails)
    if (channels.whatsapp?.enabled) {
      try {
        console.log(info('Starting WhatsApp adapter...'));
        const adapter = new WhatsAppAdapter('whatsapp-main');
        const waPhoneJid = channels.whatsapp.phoneNumber
          ? `${channels.whatsapp.phoneNumber}@s.whatsapp.net`
          : undefined;

        // Resolve LID alias for mention detection (WhatsApp uses LID in group mentions)
        const selfIdAliases: string[] = [];
        if (channels.whatsapp.phoneNumber && channels.whatsapp.authDir) {
          try {
            const lidMapPath = path.join(channels.whatsapp.authDir, `lid-mapping-${channels.whatsapp.phoneNumber}.json`);
            const lidNum = JSON.parse(fs.readFileSync(lidMapPath, 'utf-8'));
            if (lidNum) {
              selfIdAliases.push(`${lidNum}@lid`);
              console.log(info(`WhatsApp LID alias: ${lidNum}@lid`));
            }
          } catch {
            // LID mapping file may not exist yet — non-fatal
          }
        }

        const policy: ChannelPolicy = {
          dmPolicy: 'allowlist',
          groupPolicy: 'mention-only', // kept for type compat, router uses @mention check
          ownerIds: this.gatewayConfig.ownerIds ?? [],
          allowedSenders: this.gatewayConfig.ownerIds ?? [],
          selfId: waPhoneJid,
          selfIdAliases,
          ...channels.whatsapp.policy,
        };

        await this.channelRegistry.register(
          adapter,
          {
            authDir: channels.whatsapp.authDir,
            phoneNumber: channels.whatsapp.phoneNumber,
            autoRead: channels.whatsapp.autoRead ?? true,
            onQR: (qr: string) => {
              console.log(`\n  ${palette.gold}📱 WhatsApp QR Code — scan to link:${palette.reset}\n`);
              qrcode.generate(qr, { small: true }, (rendered: string) => {
                console.log(rendered);
              });
            },
          },
          policy,
        );
        console.log(ok(`WhatsApp ${palette.green}connected${palette.reset}`));
        presenceManager.registerAdapter('whatsapp-main', (chatId, durationMs) => adapter.typing(chatId, durationMs));
      } catch (err) {
        console.log(warn(`WhatsApp failed — ${(err as Error).message}`));
      }
    }
  }

  // ── HTTP API ───────────────────────────────────────────────────────────

  private async startHttpApi(): Promise<void> {
    const port = (this.gatewayConfig as any).apiPort ?? 3006;
    const apiKey = process.env.MACH6_API_KEY || process.env.API_KEY || '';

    if (!apiKey) {
      console.log(warn('No MACH6_API_KEY — HTTP API disabled'));
      return;
    }

    this.httpApi = new HttpApiServer({
      port,
      apiKey,
      allowedOrigins: (this.config as any).allowedOrigins ?? ['*'],
      onChat: async (request: ChatRequest): Promise<ChatResponse> => {
        return this.handleHttpChat(request);
      },
      onRelay: async (target: string, text: string) => {
        // Relay to WhatsApp
        try {
          const result = await this.channelRegistry.sendToChannel('whatsapp', target, {
            content: text,
          });
          return { success: result.success, error: result.error };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
      onHealth: () => this.status(),
    });

    await this.httpApi.start();
  }

  // ── Web UI ─────────────────────────────────────────────────────────────

  private startWebUi(): void {
    const webPort = (this.gatewayConfig as any).webPort ?? 3009;
    const webHost = (this.gatewayConfig as any).webHost ?? '127.0.0.1';
    try {
      this.webServer = startWebServer({
        port: webPort,
        host: webHost,
        apiPort: (this.gatewayConfig as any).apiPort ?? 3006,
        apiHost: '127.0.0.1',
        apiKey: process.env.MACH6_API_KEY || process.env.API_KEY || '',
        version: '2.1.0',
        agentName: (this.config as any).name || 'Agent',
        agentEmoji: (this.config as any).emoji || '🤖',
        providers: Array.from(PROVIDERS.keys()).map((id) => ({
          id,
          name: id === 'github-copilot'
            ? 'GitHub Copilot'
            : id === 'xai'
              ? 'xAI'
              : id.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' '),
          active: id === this.providerName,
          configured: Boolean(this.config.providers?.[id]) || id === this.providerName,
        })),
        tools: this.toolRegistry.list().map(tool => ({
          name: tool.name,
          description: tool.description,
        })),
      });
    } catch (err) {
      console.log(warn(`Web UI failed to start — ${(err as Error).message}`));
    }
  }

  /**
   * Handle an HTTP API chat request by running it through the full agent pipeline.
   * Creates a synthetic BusEnvelope and processes it like any other channel message.
   */
  private handleHttpChat(request: ChatRequest): Promise<ChatResponse> {
    return new Promise(async (resolve, reject) => {
      const sessionId = request.sessionId ?? `http-${request.source ?? 'web'}-${request.senderId ?? 'anon'}`;
      const controller = new AbortController();

      try {
        // Load or create session
        let session = this.sessionManager.load(sessionId) ?? this.sessionManager.create(sessionId, {
          provider: this.providerName,
          model: this.model,
        });

        // Build system prompt
        const turnPrompt = buildSystemPrompt({
          workspace: this.config.workspace,
          tools: this.toolRegistry.list().map(t => t.name),
          channel: 'http',
          chatType: 'direct',
          senderId: request.senderId ?? 'http-user',
        });

        if (session.messages.length > 0 && session.messages[0].role === 'system') {
          session.messages[0].content = turnPrompt;
        } else {
          session.messages.unshift({ role: 'system', content: turnPrompt });
        }

        // Build user message content
        const userContent = request.senderName
          ? `[${request.senderName}] ${request.text}`
          : request.text;

        session.messages.push({ role: 'user', content: userContent });

        // Sandbox context — HTTP API users get 'standard' tier (not admin)
        const ownerIds = this.gatewayConfig.ownerIds ?? [];
        const isOwner = request.senderId ? (ownerIds.includes('*') || ownerIds.includes(request.senderId)) : false;
        const sandboxCtx: SessionContext = {
          sessionId,
          adapterId: 'http-api',
          channelType: 'http',
          chatType: 'direct',
          senderId: request.senderId ?? 'http-user',
          isOwner,
        };
        const sandboxedTools = createSandboxedRegistry(this.toolRegistry, sandboxCtx);

        // Provider config
        const providerCfg = (this.config.providers as Record<string, any>)[this.providerName] ?? {};
        const thinkingCfg = (this.config as any).thinking;
        const provConfig = {
          model: this.model,
          maxTokens: this.config.maxTokens,
          temperature: this.config.temperature,
          systemPrompt: this.systemPrompt,
          ...(thinkingCfg ? { thinking: thinkingCfg } : {}),
          ...providerCfg,
        };

        // Run agent with BLINK continuation
        console.log(`${palette.dim}  [http]${palette.reset} Agent turn for ${palette.violet}${sessionId}${palette.reset}`);
        const startMs = Date.now();
        const blinkCtrl = new BlinkController({ enabled: true, maxDepth: 5, prepareAt: 3, cooldownMs: 1000 });

        let currentSessionMessages = session.messages;
        let finalResult: Awaited<ReturnType<typeof runAgent>> | null = null;

        while (blinkCtrl.shouldContinue()) {
          const result = await runAgent(currentSessionMessages, {
            provider: this.provider,
            providerConfig: provConfig,
            toolRegistry: sandboxedTools,
            sessionId,
            maxIterations: this.pulseBudget.getEffectiveCap(),
            contextMonitor: this.contextMonitor,
            contextStore: this.contextStore ?? undefined,
            blinkController: blinkCtrl,
            abortSignal: controller.signal,
            onEvent: (ev) => {
              if (ev.type === 'usage') {
                this.sessionManager.trackUsage(session, ev.usage.inputTokens, ev.usage.outputTokens);
              }
            },
            onToolStart: (name) => console.log(`  ${palette.violet}⚡ ${name}${palette.reset}`),
            onToolEnd: (name) => console.log(`  ${palette.green}✓ ${name}${palette.reset}`),
          });

          // Handle abort — save state and break
          if (result.aborted) {
            console.log(`${palette.dim}  [BLINK]${palette.reset} ${palette.yellow}Agent aborted${palette.reset} (http). Preserving session state.`);
            session.messages = result.messages;
            this.sessionManager.save(session);
            finalResult = result;
            break;
          }

          if (result.maxIterationsHit && blinkCtrl.needsBlink(true)) {
            blinkCtrl.recordBlink(result.iterations, result.toolCalls.length);
            console.log(`${palette.dim}  [BLINK]${palette.reset} ${palette.yellow}⚡ Blink #${blinkCtrl.getState().depth}${palette.reset} (http) — continuing`);
            currentSessionMessages = result.messages;
            if (currentSessionMessages.length > 0) {
              const last = currentSessionMessages[currentSessionMessages.length - 1];
              if (last.role === 'assistant' && last.content === '[Max iterations reached]') {
                currentSessionMessages.pop();
              }
            }
            currentSessionMessages.push({ role: 'user', content: blinkCtrl.getResumeMessage() });
            await new Promise(r => setTimeout(r, blinkCtrl.getCooldownMs()));
            continue;
          }

          blinkCtrl.recordComplete(result.iterations, result.toolCalls.length);
          finalResult = result;
          break;
        }

        if (!finalResult) {
          finalResult = { text: '[Blink depth exceeded]', messages: currentSessionMessages, toolCalls: [], iterations: 0, maxIterationsHit: true, aborted: false };
        }

        // Save session (skip if already saved during abort)
        if (!finalResult.aborted) {
          session.messages = finalResult.messages;
          if (finalResult.text && finalResult.text !== '[Max iterations reached]' && finalResult.text !== '[Blink depth exceeded]') {
            session.messages.push({ role: 'assistant', content: finalResult.text });
          }
          this.sessionManager.save(session);
        }

        // PULSE: record total iterations
        const blinkState = blinkCtrl.getState();
        const totalIter = blinkState.depth > 0 ? blinkState.totalIterations : finalResult.iterations;
        this.pulseBudget.recordSession(totalIter);

        resolve({
          text: finalResult.text ?? '',
          sessionId,
          durationMs: Date.now() - startMs,
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  // ── Message Loop ───────────────────────────────────────────────────────

  /**
   * The core message loop. Polls the bus for new messages and dispatches
   * agent turns. Each session gets at most one concurrent agent turn.
   * 
   * When a new message arrives during an active turn, the bus handles it:
   * - interrupt priority → cancels current turn
   * - high priority → queued, injected at next iteration
   * - normal/low → queued for after current turn
   */
  private startMessageLoop(): void {
    const bus = this.channelRegistry.getBus();
    const knownSessions = new Set<string>();

    // Check for new sessions periodically
    setInterval(() => {
      if (this.shutdownRequested) return;

      const routes = this.channelRegistry.getRouter().getRoutes();
      for (const route of routes) {
        if (knownSessions.has(route.sessionId)) continue;
        knownSessions.add(route.sessionId);

        // Subscribe to this session
        bus.subscribe(route.sessionId, (envelope) => {
          this.handleEnvelope(envelope);
        });

        // Subscribe to interrupts
        bus.onInterrupt(route.sessionId, (envelope) => {
          this.handleInterrupt(envelope);
        });
      }
    }, 100);
  }

  private pendingEnvelopes = new Map<string, BusEnvelope[]>();

  private async handleEnvelope(envelope: BusEnvelope): Promise<void> {
    const sessionId = envelope.sessionId!;

    // ── Forward Routes ───────────────────────────────────────────────────
    // If this chatId is mapped to a sibling gateway (e.g. Aria), forward
    // the message via HTTP API instead of processing locally.
    const forwardRoutes = (this.config as any).forwardRoutes as Record<string, { url: string; apiKey?: string; name?: string }> | undefined;
    if (forwardRoutes && envelope.source.chatId in forwardRoutes) {
      const route = forwardRoutes[envelope.source.chatId];
      const routeName = route.name ?? route.url;
      console.log(`${palette.dim}  [forward]${palette.reset} → ${palette.cyan}${routeName}${palette.reset} (${envelope.source.chatId})`);

      // Show typing indicator while Aria processes (sustained — will be paused when response arrives)
      try {
        const adapter = this.channelRegistry.get(envelope.source.adapterId);
        if (adapter && 'typing' in adapter && typeof (adapter as any).typing === 'function') {
          await (adapter as any).typing(envelope.source.chatId, Infinity);
        }
      } catch { /* ignore typing errors */ }

      try {
        const body = JSON.stringify({
          text: envelope.payload.text ?? '',
          channel: envelope.source.channelType,
          chatId: envelope.source.chatId,
          senderId: envelope.source.senderId,
          senderName: envelope.source.senderName,
          messageId: envelope.metadata.platformMessageId,
        });
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (route.apiKey) headers['Authorization'] = `Bearer ${route.apiKey}`;

        const resp = await fetch(route.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(120_000) });
        const data = await resp.json() as { text?: string; response?: string; error?: string };
        const responseText = data.text ?? data.response;

        if (responseText && responseText !== 'HEARTBEAT_OK' && responseText !== 'NO_REPLY') {
          console.log(`${palette.dim}  [forward]${palette.reset} ← ${palette.green}${responseText.length} chars${palette.reset} from ${palette.cyan}${routeName}${palette.reset}`);
          await this.channelRegistry.send(
            envelope.source.adapterId,
            envelope.source.chatId,
            { content: responseText, replyToId: envelope.metadata.platformMessageId },
          );
        } else if (data.error) {
          console.log(`${palette.dim}  [forward]${palette.reset} ${palette.red}Error:${palette.reset} ${data.error}`);
        }
      } catch (err) {
        console.error(`  ${palette.red}✗ [forward]${palette.reset} ${routeName}: ${err}`);
        // Fallback: let the user know
        try {
          await this.channelRegistry.send(
            envelope.source.adapterId,
            envelope.source.chatId,
            { content: `⚠️ ${routeName} is unreachable. Forwarding failed.` },
          );
        } catch { /* ignore */ }
      } finally {
        // Pause typing indicator after forward completes (success or failure)
        try {
          const adapter = this.channelRegistry.get(envelope.source.adapterId);
          if (adapter && 'pauseTyping' in adapter && typeof (adapter as any).pauseTyping === 'function') {
            await (adapter as any).pauseTyping(envelope.source.chatId);
          }
        } catch { /* ignore */ }
      }
      return; // Don't process locally
    }

    // ── Day 21: Sibling loop breaker REMOVED ─────────────────────────────
    // The Mention-Only Protocol handles echo loops structurally:
    // A bot only processes messages that @mention it by ID.
    // If Bot A sends a message without @Bot_B, Bot B never sees it.
    // No cooldowns, no sibling tracking, no react-as-loop-breaker needed.

    // Check if there's already an active turn for this session
    if (this.activeTurns.has(sessionId)) {
      // Queue the envelope for when the current turn finishes
      const pending = this.pendingEnvelopes.get(sessionId) ?? [];
      pending.push(envelope);
      this.pendingEnvelopes.set(sessionId, pending);
      console.log(`${palette.dim}  [gateway]${palette.reset} Queued for active session ${palette.violet}${sessionId}${palette.reset} ${palette.dim}(${pending.length} pending)${palette.reset}`);
      return;
    }

    // Start a new agent turn
    await this.runAgentTurn(envelope);
  }

  private handleInterrupt(envelope: BusEnvelope): void {
    const sessionId = envelope.sessionId!;
    const active = this.activeTurns.get(sessionId);
    if (!active) return;

    console.log(`${palette.dim}  [gateway]${palette.reset} ${palette.yellow}Interrupting${palette.reset} session ${palette.violet}${sessionId}${palette.reset}`);
    active.abortController.abort('new_message');
  }

  // ── Agent Turn ─────────────────────────────────────────────────────────

  private async runAgentTurn(envelope: BusEnvelope): Promise<void> {
    const sessionId = envelope.sessionId!;
    const controller = new AbortController();

    const turn: ActiveTurn = {
      sessionId,
      abortController: controller,
      startedAt: Date.now(),
      channelType: envelope.source.channelType,
      chatId: envelope.source.chatId,
      adapterId: envelope.source.adapterId,
    };

    this.activeTurns.set(sessionId, turn);

    // v2.0 — Track session for hot resume
    this.hotResume.trackSession({
      sessionId,
      channelType: envelope.source.channelType,
      adapterId: envelope.source.adapterId,
      chatId: envelope.source.chatId,
      lastSenderId: envelope.source.senderId,
      wasActive: true,
      provider: this.providerName,
      model: this.model,
    });
    this.metrics.recordTurn();

    // Build sandbox context for this session
    const ownerIds = this.gatewayConfig.ownerIds ?? [];
    const isOwner = ownerIds.includes('*') || ownerIds.includes(envelope.source.senderId);
    const chatType = (envelope.source.chatType === 'channel' || envelope.source.chatType === 'thread' || envelope.source.chatType === 'group' || envelope.source.chatId.includes('@g.') || envelope.metadata.guildId) ? 'group' as const : 'direct' as const;
    const sandboxCtx: SessionContext = {
      sessionId,
      adapterId: envelope.source.adapterId,
      channelType: envelope.source.channelType,
      chatType,
      senderId: envelope.source.senderId,
      isOwner,
    };
    const sandboxedTools = createSandboxedRegistry(this.toolRegistry, sandboxCtx);

    // Record user activity for heartbeat scheduling
    if (envelope.source.adapterId !== 'heartbeat') {
      this.heartbeat.recordUserActivity();
    }
    this.channelRegistry.setSessionActive(sessionId, true);

    // ── WhatsApp Read Receipts ───────────────────────────────────────────
    // Do NOT auto mark-read here. The agent calls mark_read explicitly
    // per message, which preserves unread badges / notifications on the
    // user's phone. Auto-read was eating Ali's notifications (Day 27).
    // UPDATE (Day 44): Mark read immediately on receipt (before LLM turn) so Ali
    // sees blue ticks right away. Agent still calls mark_read per message for
    // any messages it receives mid-session, but this covers the first receipt.
    if (envelope.source.channelType === 'whatsapp' && envelope.metadata.platformMessageId) {
      const waAdapter = this.channelRegistry.get(envelope.source.adapterId);
      if (waAdapter && typeof (waAdapter as any).markRead === 'function') {
        (waAdapter as any).markRead(envelope.source.chatId, envelope.metadata.platformMessageId).catch(() => {});
      }
    }

    // Start sustained typing (refreshes every 20s for WA, 8s for Discord)
    const typingTarget = { adapterId: envelope.source.adapterId, chatId: envelope.source.chatId };
    presenceManager.startTyping(typingTarget);

    try {
      // Load or create session
      let session = this.sessionManager.load(sessionId) ?? this.sessionManager.create(sessionId, {
        provider: this.providerName,
        model: this.model,
      });

      // Build channel-aware system prompt (refreshes workspace files each turn)
      // Use per-adapter prompt files if configured (multi-persona support)
      const adapterFiles = this.adapterPromptFiles.get(envelope.source.adapterId);
      const turnPrompt = buildSystemPrompt({
        workspace: this.config.workspace,
        tools: this.toolRegistry.list().map(t => t.name),
        channel: envelope.source.channelType,
        chatType: envelope.source.chatType === 'channel' || envelope.source.chatType === 'thread' || envelope.source.chatType === 'group' || envelope.source.chatId.includes('@g.') ? 'group' : 'direct',
        senderId: envelope.source.senderId,
        workspaceFiles: adapterFiles,
      });
      // Replace or insert system prompt (always fresh — workspace files may have changed)
      if (session.messages.length > 0 && session.messages[0].role === 'system') {
        session.messages[0].content = turnPrompt;
      } else {
        session.messages.unshift({ role: 'system', content: turnPrompt });
      }

      // Add user message (with voice transcription if applicable)
      let userContent = this.buildUserContent(envelope);
      
      // Voice middleware: auto-transcribe voice/PTT messages
      const voiceResult = await processVoiceInbound(envelope);
      if (voiceResult && !voiceResult.isEmpty) {
        // Replace media descriptor with transcript — agent sees text, not a file path
        userContent = userContent.replace(/\[voice,.*?\]/, `[🎤 voice message, ${voiceResult.duration}s]`);
        userContent += `\n\n${voiceResult.text}`;
      }
      
      session.messages.push({ role: 'user', content: userContent });

      // Pre-flight context trim: estimate token count and archive if approaching limit
      // Rough estimate: 1 token ≈ 4 chars. Model limit 128K, leave 20K headroom.
      const TOKEN_LIMIT = 128_000;
      const HEADROOM = 20_000;
      const estimatedTokens = session.messages.reduce((sum, m) => {
        const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
        return sum + Math.ceil(content.length / 4);
      }, 0);
      if (estimatedTokens > TOKEN_LIMIT - HEADROOM) {
        console.log(`${palette.dim}  [gateway]${palette.reset} ${palette.yellow}⚠${palette.reset} Pre-flight trim: ~${estimatedTokens} tokens ${palette.dim}(limit ${TOKEN_LIMIT})${palette.reset}`);
        const archived = this.sessionManager.archive(sessionId, 30);
        console.log(`${palette.dim}  [gateway]${palette.reset} Archived ${archived} messages → ${session.messages.length} remaining`);
        // Feed archived messages to VDB for persistent memory
        try {
          const { VectorDB, ingestSessions } = await import("../memory/vdb.js");
          const vdb = new VectorDB(process.env.MACH6_WORKSPACE ?? process.cwd());
          const archiveDir = path.join(this.config.sessionsDir ?? ".sessions", "archive");
          if (fs.existsSync(archiveDir)) {
            const result = ingestSessions(vdb, archiveDir);
            if (result.indexed > 0) console.log(`${palette.dim}  [vdb]${palette.reset} Ingested ${result.indexed} new memories from archive`);
          }
        } catch { /* non-fatal */ }
        // Reload session after archive
        const trimmed = this.sessionManager.load(sessionId);
        if (trimmed) {
          session.messages = trimmed.messages;
        }
      }

      // Provider config
      const providerCfg = (this.config.providers as Record<string, any>)[this.providerName] ?? {};
      const thinkingCfg = (this.config as any).thinking;
      const provConfig: ProviderConfig = {
        model: this.model,
        maxTokens: this.config.maxTokens,
        temperature: this.config.temperature,
        systemPrompt: this.systemPrompt,
        ...(thinkingCfg ? { thinking: thinkingCfg } : {}),
        ...providerCfg,
      };

      // Run agent with BLINK continuation
      console.log(`\n${palette.dim}  [turn]${palette.reset} ${palette.violet}${sessionId}${palette.reset} ${palette.dim}via${palette.reset} ${envelope.source.channelType}${palette.dim}/${palette.reset}${envelope.source.chatId}`);
      const turnStartTime = Date.now();
      const blinkCtrl = new BlinkController({ enabled: true, maxDepth: 5, prepareAt: 3, cooldownMs: 1000 });

      let currentSessionMessages = session.messages;
      let finalResult: Awaited<ReturnType<typeof runAgent>> | null = null;

      // Build the agent runner options factory (reused for fallback)
      const makeRunOpts = (useProvider: Provider, useConfig: ProviderConfig) => ({
        provider: useProvider,
        providerConfig: useConfig,
        toolRegistry: sandboxedTools,
        sessionId,
        maxIterations: this.pulseBudget.getEffectiveCap(),
        contextMonitor: this.contextMonitor,
        contextStore: this.contextStore ?? undefined,
        blinkController: blinkCtrl,
        abortSignal: controller.signal,
        onEvent: (ev: any) => {
          if (ev.type === 'usage') {
            this.sessionManager.trackUsage(session, ev.usage.inputTokens, ev.usage.outputTokens);
            console.log(`  ${palette.dim}📊 +${ev.usage.inputTokens}in / +${ev.usage.outputTokens}out${palette.reset}`);
          }
          if (ev.type === 'text_delta' || ev.type === 'done') {
            presenceManager.llmStreaming();
          }
        },
        onToolStart: (name: string) => {
          console.log(`  ${palette.violet}⚡ ${name}${palette.reset}`);
          presenceManager.toolStart(name);
        },
        onToolEnd: (name: string, res: string) => {
          const preview = res.length > 100 ? res.slice(0, 100) + '...' : res;
          console.log(`  ${palette.green}✓ ${name}${palette.reset} ${palette.dim}${preview.split('\n')[0]}${palette.reset}`);
          presenceManager.toolEnd(name);
        },
      });

      // Helper: run agent with fallback chain
      const runWithFallback = async (msgs: typeof currentSessionMessages): Promise<Awaited<ReturnType<typeof runAgent>>> => {
        try {
          const turnStartTime = Date.now();
          const result = await runAgent(msgs, makeRunOpts(this.provider, provConfig));
          // v2.0 — Record provider success metrics
          this.providerHealth.recordSuccess(this.providerName, Date.now() - turnStartTime);
          return result;
        } catch (primaryErr) {
          // v2.0 — Record primary provider failure
          this.providerHealth.recordFailure(this.providerName, primaryErr instanceof Error ? primaryErr.message : String(primaryErr));
          this.metrics.recordProviderError(this.providerName, primaryErr instanceof Error ? primaryErr.message : String(primaryErr));

          // Try each fallback provider in order
          for (const fb of this.fallbackChain) {
            // v2.0 — Skip providers with open circuit breaker
            if (!this.providerHealth.isAvailable(fb.name)) {
              console.log(`${palette.dim}  [fallback]${palette.reset} ${palette.red}${fb.name} circuit open${palette.reset} — skipping`);
              continue;
            }

            console.log(`${palette.dim}  [fallback]${palette.reset} ${palette.yellow}Primary ${this.providerName} failed${palette.reset}: ${primaryErr instanceof Error ? primaryErr.message : primaryErr}`);
            console.log(`${palette.dim}  [fallback]${palette.reset} Trying ${palette.cyan}${fb.name}${palette.reset}...`);
            try {
              const fbCfg = (this.config.providers as Record<string, any>)[fb.name] ?? {};
              const fbProvConfig: ProviderConfig = {
                model: fbCfg.model ?? this.model,
                maxTokens: this.config.maxTokens,
                temperature: this.config.temperature,
                systemPrompt: this.systemPrompt,
                ...fbCfg,
              };
              const fbStartTime = Date.now();
              const result = await runAgent(msgs, makeRunOpts(fb.provider, fbProvConfig));
              console.log(`${palette.dim}  [fallback]${palette.reset} ${palette.green}${fb.name} succeeded${palette.reset}`);
              // v2.0 — Record fallback success
              this.providerHealth.recordSuccess(fb.name, Date.now() - fbStartTime);
              return result;
            } catch (fbErr) {
              console.log(`${palette.dim}  [fallback]${palette.reset} ${palette.red}${fb.name} also failed${palette.reset}: ${fbErr instanceof Error ? fbErr.message : fbErr}`);
              // v2.0 — Record fallback failure
              this.providerHealth.recordFailure(fb.name, fbErr instanceof Error ? fbErr.message : String(fbErr));
              // Continue to next fallback
            }
          }
          // All fallbacks exhausted — throw original error
          throw primaryErr;
        }
      };

      // BLINK loop: run agent, check if budget hit, blink and continue if needed
      while (blinkCtrl.shouldContinue()) {
        const result = await runWithFallback(currentSessionMessages);

        // Check if agent was aborted (SIGTERM, interrupt, new message)
        // Save session state so work-in-progress is not lost on restart
        if (result.aborted) {
          console.log(`${palette.dim}  [BLINK]${palette.reset} ${palette.yellow}Agent aborted${palette.reset} at iteration ${result.iterations}. Preserving session state.`);
          session.messages = result.messages;
          this.sessionManager.save(session);
          console.log(`${palette.dim}  [BLINK]${palette.reset} Session ${palette.violet}${sessionId}${palette.reset} saved (${result.messages.length} messages, ${result.toolCalls.length} tool calls preserved)`);
          // Don't blink, don't continue — the process is shutting down
          finalResult = result;
          break;
        }

        // Check if BLINK is needed
        if (result.maxIterationsHit && blinkCtrl.needsBlink(true)) {
          // Record the blink
          blinkCtrl.recordBlink(result.iterations, result.toolCalls.length);
          console.log(`${palette.dim}  [BLINK]${palette.reset} ${palette.yellow}⚡ Blink #${blinkCtrl.getState().depth}${palette.reset} — continuing with fresh budget`);

          // Save intermediate state so nothing is lost
          currentSessionMessages = result.messages;
          // Strip the "[Max iterations reached]" text — it's an artifact, not a real response
          if (currentSessionMessages.length > 0) {
            const last = currentSessionMessages[currentSessionMessages.length - 1];
            if (last.role === 'assistant' && last.content === '[Max iterations reached]') {
              currentSessionMessages.pop();
            }
          }

          // Inject resume message
          const resumeMsg = blinkCtrl.getResumeMessage();
          currentSessionMessages.push({ role: 'user', content: resumeMsg });

          // Cooldown before next cycle
          await new Promise(r => setTimeout(r, blinkCtrl.getCooldownMs()));

          // Loop continues — fresh runAgent with full budget
          continue;
        }

        // Normal completion or blink capped — we're done
        blinkCtrl.recordComplete(result.iterations, result.toolCalls.length);
        finalResult = result;
        break;
      }

      // If loop exhausted without a finalResult (shouldn't happen but safety net)
      if (!finalResult) {
        console.warn(`[BLINK] Loop ended without result — depth capped`);
        finalResult = { text: '[Blink depth exceeded]', messages: currentSessionMessages, toolCalls: [], iterations: 0, maxIterationsHit: true, aborted: false };
      }

      const turnElapsed = Date.now() - turnStartTime;
      const blinkState = blinkCtrl.getState();
      const blinkInfo = blinkState.depth > 0 ? `, ${blinkState.depth} blinks, ${blinkState.totalIterations} total iter` : '';
      const abortInfo = finalResult.aborted ? ' (ABORTED — state preserved)' : '';
      console.log(`${palette.dim}  [turn]${palette.reset} Complete ${palette.dim}— ${turnElapsed}ms, ${finalResult.iterations} iter, ${finalResult.toolCalls.length} tools${blinkInfo}${abortInfo}${palette.reset}`);

      // Save session (skip if already saved during abort handling above)
      if (!finalResult.aborted) {
        session.messages = finalResult.messages;
        if (finalResult.text && finalResult.text !== '[Max iterations reached]' && finalResult.text !== '[Blink depth exceeded]') {
          session.messages.push({ role: 'assistant', content: finalResult.text });
        }
        this.sessionManager.save(session);
      }

      // PULSE: record TOTAL iteration count (across all blinks)
      const totalIter = blinkState.depth > 0 ? blinkState.totalIterations : finalResult.iterations;
      const pulseResult = this.pulseBudget.recordSession(totalIter);
      if (pulseResult.reverted) {
        console.log(`${palette.dim}  [PULSE]${palette.reset} Budget reverted to ${pulseResult.effectiveCap} — light workload detected`);
      }

      // Auto-archive bloated sessions (>200KB → keep last 30 messages)
      this.sessionManager.autoArchive();

      // Send response back through the channel (skip if aborted — process is shutting down)
      if (!finalResult.aborted && finalResult.text && finalResult.text !== 'NO_REPLY' && finalResult.text !== 'HEARTBEAT_OK'
          && finalResult.text !== '[Max iterations reached]' && finalResult.text !== '[Blink depth exceeded]') {
        // Auto-mention: in Discord non-DM channels, prepend @sender if not already present
        let responseText = finalResult.text;
        if (envelope.source.channelType === 'discord' && envelope.source.chatType !== 'dm' && envelope.source.senderId) {
          const mentionTag = `<@${envelope.source.senderId}>`;
          if (!responseText.includes(mentionTag)) {
            responseText = `${mentionTag} ${responseText}`;
          }
        }

        console.log(`${palette.dim}  [send]${palette.reset} → ${envelope.source.adapterId}/${envelope.source.chatId} ${palette.dim}(${responseText.length} chars)${palette.reset}`);
        try {
          // Voice middleware: if original message was voice, send voice reply
          if ((envelope as any)._isVoice && envelope.source.channelType === 'whatsapp') {
            console.log(`${palette.dim}  [voice]${palette.reset} Generating voice reply...`);
            const voicePath = await generateVoiceReply(responseText);
            if (voicePath) {
              // Send voice note
              await this.channelRegistry.send(
                envelope.source.adapterId,
                envelope.source.chatId,
                {
                  content: '',
                  media: [{
                    type: 'voice' as any,
                    mimeType: 'audio/ogg; codecs=opus',
                    path: voicePath,
                  }],
                  replyToId: envelope.metadata.platformMessageId,
                },
              );
              console.log(`${palette.dim}  [voice]${palette.reset} ${palette.green}voice reply sent${palette.reset}`);
              // Also send text for accessibility
              await this.channelRegistry.send(
                envelope.source.adapterId,
                envelope.source.chatId,
                { content: responseText },
              );
              cleanupVoiceFile(voicePath);
            } else {
              // TTS failed — fall back to text only
              console.log(`${palette.dim}  [voice]${palette.reset} ${palette.yellow}TTS failed, sending text only${palette.reset}`);
              await this.channelRegistry.send(
                envelope.source.adapterId,
                envelope.source.chatId,
                {
                  content: responseText,
                  replyToId: envelope.metadata.platformMessageId,
                },
              );
            }
          } else {
            const sendResult = await this.channelRegistry.send(
              envelope.source.adapterId,
              envelope.source.chatId,
              {
                content: responseText,
                replyToId: envelope.metadata.platformMessageId,
              },
            );
          }
          console.log(`${palette.dim}  [send]${palette.reset} ${palette.green}delivered${palette.reset}`);
        } catch (sendErr) {
          console.error(`  ${palette.red}✗ [send]${palette.reset} ${sendErr}`);
        }
      } else {
        console.log(`${palette.dim}  [turn]${palette.reset} No response ${palette.dim}(${finalResult.text ? finalResult.text.slice(0, 50) : 'null'})${palette.reset}`);
      }

    } catch (err) {
      if (controller.signal.aborted) {
        console.log(`${palette.dim}  [turn]${palette.reset} ${palette.yellow}Interrupted${palette.reset} ${palette.violet}${sessionId}${palette.reset}`);
        // Re-process with accumulated messages
        // Check our pending queue + bus drain
        const pending = this.pendingEnvelopes.get(sessionId) ?? [];
        const busPending = this.channelRegistry.getBus().drain(sessionId);
        const allPending = [...pending, ...busPending];
        this.pendingEnvelopes.delete(sessionId);
        if (allPending.length > 0) {
          // Recursion with new context
          this.activeTurns.delete(sessionId);
          this.channelRegistry.setSessionActive(sessionId, false);
          await this.runAgentTurn(allPending[allPending.length - 1]); // most recent message
          return;
        }
      } else {
        console.error(`  ${palette.red}✗ [turn]${palette.reset} ${palette.violet}${sessionId}${palette.reset}: ${err}`);
        // Send error message
        try {
          await this.channelRegistry.send(
            envelope.source.adapterId,
            envelope.source.chatId,
            { content: `⚠️ Error: ${err instanceof Error ? err.message : String(err)}` },
          );
        } catch { /* ignore send errors */ }
      }
    } finally {
      this.activeTurns.delete(sessionId);
      this.channelRegistry.setSessionActive(sessionId, false);
      presenceManager.stopTyping(typingTarget);

      // Process any pending messages that arrived during this turn
      const pending = this.pendingEnvelopes.get(sessionId);
      if (pending && pending.length > 0) {
        this.pendingEnvelopes.delete(sessionId);
        console.log(`${palette.dim}  [gateway]${palette.reset} Processing ${pending.length} pending for ${palette.violet}${sessionId}${palette.reset}`);
        // Process the most recent pending message (others are stale context)
        await this.runAgentTurn(pending[pending.length - 1]);
      }
    }
  }

  private buildUserContent(envelope: BusEnvelope): string {
    const parts: string[] = [];

    // Inject message metadata so the LLM can reference message IDs
    // (needed for react, mark_read, delete_message tools)
    const msgId = envelope.metadata.platformMessageId;
    if (msgId) {
      parts.push(`<<message_id=${msgId}>>`);
    }

    // Sender context — include ID for Discord @mentions
    if (envelope.source.senderName) {
      if (envelope.source.channelType === 'discord' && envelope.source.senderId) {
        parts.push(`[${envelope.source.senderName}] (Discord ID: ${envelope.source.senderId}, mention as <@${envelope.source.senderId}>)`);
      } else {
        parts.push(`[${envelope.source.senderName}]`);
      }
    }

    // Reply context
    if (envelope.source.replyToId) {
      parts.push(`(replying to message ${envelope.source.replyToId})`);
    }

    // Text
    if (envelope.payload.text) {
      parts.push(envelope.payload.text);
    }

    // Media descriptions — include local path if downloaded
    if (envelope.payload.media?.length) {
      for (const m of envelope.payload.media) {
        const desc: string[] = [m.type];
        if (m.filename) desc.push(m.filename);
        else if (m.mimeType) desc.push(m.mimeType);
        if (m.path) desc.push(`path=${m.path}`);
        if (m.caption) desc.push(`caption="${m.caption}"`);
        if (m.width && m.height) desc.push(`${m.width}x${m.height}`);
        parts.push(`[${desc.join(', ')}]`);
      }
    }

    return parts.join(' ');
  }

  // ── COMB Auto-Flush on Shutdown ──────────────────────────────────────

  /**
   * Flush the last N messages from all active sessions into COMB before shutdown.
   * This gives the next session lossless context of what was happening when the
   * process went down — conversations, directives, mid-task state.
   * 
   * Global: every Symbiote instance (AVA, Aria, future) gets this automatically.
   */
  private async flushCombOnShutdown(tailMessages = 4): Promise<void> {
    try {
      const sessionSummaries = this.sessionManager.list();
      const now = Date.now();
      const RECENCY_WINDOW = 24 * 60 * 60 * 1000;
      let flushedCount = 0;

      for (const summary of sessionSummaries) {
        if (now - summary.updatedAt > RECENCY_WINDOW) continue;

        const session = this.sessionManager.load(summary.id);
        if (!session || session.messages.length === 0) continue;

        const sessionLabel = summary.label ?? summary.id;
        flushMessages(sessionLabel, session.messages, tailMessages);
        flushedCount++;
      }

      if (flushedCount > 0) {
        console.log(`${palette.dim}  [comb]${palette.reset} ${palette.green}Auto-flushed${palette.reset} ${flushedCount} session(s) → VDB`);
      } else {
        console.log(`${palette.dim}  [comb]${palette.reset} No recent sessions to flush`);
      }
    } catch (err) {
      console.error(`${palette.dim}  [comb]${palette.reset} ${palette.red}Auto-flush failed${palette.reset}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ── Signals ────────────────────────────────────────────────────────────

  private setupSignals(): void {
    const shutdown = async (signal: string) => {
      if (this.shutdownRequested) return;
      this.shutdownRequested = true;
      console.log(`\n${palette.dim}  [gateway]${palette.reset} ${palette.yellow}${signal}${palette.reset} — shutting down...`);

      // Cancel all active turns
      for (const [, turn] of this.activeTurns) {
        turn.abortController.abort('shutdown');
      }

      // ── COMB auto-flush: persist conversation tail before exit ──
      // Runs BEFORE channels disconnect — needs filesystem access
      await this.flushCombOnShutdown(4);

      // Disconnect all channels
      await this.channelRegistry.destroy();

      // Stop HTTP API
      if (this.httpApi) await this.httpApi.stop();

      // Stop Web UI
      if (this.webServer) this.webServer.close();

      // Disconnect MCP bridges
      for (const bridge of this.mcpBridges) {
        try { bridge.disconnect(); } catch { /* ignore */ }
      }

      presenceManager.stopAll();
      this.stopVdbPulse();
      this.heartbeat.stop();

      // v2.0 — Save session state for hot resume + flush metrics
      this.hotResume.shutdown();
      this.metrics.flush();

      console.log(`${palette.dim}  [gateway]${palette.reset} Shutdown complete.`);
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // SIGUSR1 = hot-reload config (Linux/macOS only — not supported on Windows)
    // On Windows: restart the process, or POST /api/v1/health to verify state
    if (process.platform !== 'win32') {
      process.on('SIGUSR1', () => {
        console.log(`${palette.dim}  [gateway]${palette.reset} ${palette.cyan}SIGUSR1${palette.reset} — reloading config...`);
        try {
          this.config = loadConfig(this.gatewayConfig.configPath);
          this.providerName = this.config.defaultProvider;
          this.provider = PROVIDERS.get(this.providerName)!;
          this.model = this.config.defaultModel;
          // Rebuild fallback chain
          this.fallbackChain = [];
          if (this.config.fallbackProviders?.length) {
            for (const fbName of this.config.fallbackProviders) {
              const fbProvider = PROVIDERS.get(fbName);
              if (fbProvider) this.fallbackChain.push({ name: fbName, provider: fbProvider });
            }
          }
          this.systemPrompt = buildSystemPrompt({
            workspace: this.config.workspace,
            tools: this.toolRegistry.list().map(t => t.name),
          });
          console.log(`${palette.dim}  [gateway]${palette.reset} Provider: ${palette.cyan}${this.providerName}/${this.model}${palette.reset}${this.fallbackChain.length > 0 ? ` → fallback: ${this.fallbackChain.map(f => f.name).join(' → ')}` : ''}`);
          console.log(`${palette.dim}  [gateway]${palette.reset} System prompt refreshed ${palette.dim}(${this.systemPrompt.length} chars)${palette.reset}`);
          console.log(ok('Config reloaded successfully'));
        } catch (err) {
          console.error(`  ${palette.red}✗ [gateway]${palette.reset} Config reload failed: ${err}`);
        }
      });
    }
  }

  // ── Status ─────────────────────────────────────────────────────────────

  status() {
    return {
      version: '2.0.0',
      uptime: Date.now() - this.startTime,
      uptimeHuman: this.formatUptime(Date.now() - this.startTime),
      provider: `${this.providerName}/${this.model}`,
      channels: this.channelRegistry.list(),
      activeTurns: this.activeTurns.size,
      sessions: this.sessionManager.list().length,
      tools: this.toolRegistry.list().length,
      // v2.0 additions
      providerHealth: this.providerHealth.getAllHealth(),
      metrics: this.metrics.snapshot(),
      memory: {
        rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
        heap: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      },
      pid: process.pid,
    };
  }

  private formatUptime(ms: number): string {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    if (d > 0) return `${d}d ${h % 24}h ${m % 60}m`;
    if (h > 0) return `${h}h ${m % 60}m`;
    if (m > 0) return `${m}m ${s % 60}s`;
    return `${s}s`;
  }
}

// ─── CLI Entry ─────────────────────────────────────────────────────────────

export async function startGateway(configPath?: string): Promise<SymbioteGateway> {
  // Load gateway config from symbiote config or env
  const config = loadConfig(configPath);

  // Build gateway config from environment + symbiote config
  const gatewayConfig: GatewayConfig = {
    configPath,
    ownerIds: (config as any).ownerIds ?? [],
    channels: {
      discord: {
        enabled: !!process.env.DISCORD_BOT_TOKEN || !!(config as any).discord?.token,
        token: process.env.DISCORD_BOT_TOKEN ?? (config as any).discord?.token ?? '',
        botId: (config as any).discord?.botId,
        adapterId: (config as any).discord?.adapterId ?? 'discord-main',
        policy: (config as any).discord?.policy,
      },
      whatsapp: {
        enabled: !!(config as any).whatsapp?.enabled,
        authDir: (config as any).whatsapp?.authDir ?? path.join(os.homedir(), '.mach6', 'whatsapp-auth'),
        phoneNumber: (config as any).whatsapp?.phoneNumber,
        autoRead: (config as any).whatsapp?.autoRead ?? true,
        policy: (config as any).whatsapp?.policy,
      },
    },
    // Additional Discord bot instances
    discordExtra: ((config as any).discordExtra ?? []).map((extra: any) => ({
      enabled: extra.enabled !== false,
      token: extra.token ?? '',
      botId: extra.botId,
      adapterId: extra.adapterId ?? `discord-${extra.botId ?? 'extra'}`,
      policy: extra.policy,
      promptFiles: extra.promptFiles,
    })),
    apiPort: (config as any).apiPort ?? 3006,
    webPort: (config as any).webPort ?? 3009,
    webHost: (config as any).webHost ?? '127.0.0.1',
  };

  const gateway = new SymbioteGateway(gatewayConfig);
  await gateway.start();
  return gateway;
}

// Run directly
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const configPath = process.argv.find(a => a.startsWith('--config='))?.split('=')[1];
  startGateway(configPath).catch(err => {
    console.error(`  ${palette.red}✗${palette.reset} Gateway startup failed: ${err}`);
    process.exit(1);
  });
}
