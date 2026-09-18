// SARSI — Self-Aware Routing Self-Identity
// Machine-readable routing identity + goals that persist across restarts.
// The orchestrator reads this at boot to calibrate provider, channel, and tool routing.

export interface SarsiModel {
  /** Schema version for forward compatibility */
  version: string;

  /** When this model was last updated */
  updatedAt: string;

  /** Identity — who the agent is and how it presents */
  identity: {
    name: string;
    role: string;
    description: string;
    /** Preferred communication style */
    style: 'concise' | 'detailed' | 'adaptive';
  };

  /** Routing goals — what the agent optimizes for */
  goals: RoutingGoal[];

  /** Provider routing rules — which provider for which task type */
  providerRules: ProviderRule[];

  /** Channel routing rules — which channel gets what treatment */
  channelRules: ChannelRule[];

  /** Tool routing rules — which tools are preferred for which operations */
  toolRules: ToolRule[];

  /** Performance metrics snapshot — used by Curator to evaluate rule quality */
  metrics: {
    totalInteractions: number;
    totalTokensUsed: number;
    averageLatencyMs: number;
    toolSuccessRate: number;
    routingAccuracy: number; // 0..1 — how often the chosen provider was optimal
    lastUpdated: string;
  };

  /** Changelog of applied rule changes — for rollback */
  ruleHistory: RuleChange[];

  /** Confidence scores per rule — Curator adjusts these */
  confidence: Record<string, number>; // ruleId → 0..1
}

export interface RoutingGoal {
  id: string;
  description: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  metric: string; // e.g., 'latency', 'cost', 'quality', 'reliability'
  target: number;
  weight: number; // 0..1
}

export interface ProviderRule {
  id: string;
  taskType: string; // e.g., 'code', 'reasoning', 'creative', 'simple_qa', 'long_context'
  provider: string;
  model: string;
  priority: number; // 0..1 — higher = more preferred
  conditions?: string[]; // e.g., ['context_length > 100000', 'has_code = true']
  rationale?: string;
}

export interface ChannelRule {
  id: string;
  channel: 'discord' | 'whatsapp' | 'http' | 'all';
  behavior: string; // e.g., 'concise_responses', 'voice_transcription', 'markdown_enabled'
  enabled: boolean;
  config?: Record<string, unknown>;
}

export interface ToolRule {
  id: string;
  operation: string; // e.g., 'file_read', 'web_fetch', 'exec', 'memory_search'
  preferredTool: string;
  fallbackTool?: string;
  maxRetries: number;
  timeoutMs: number;
  conditions?: string[];
}

export interface RuleChange {
  id: string;
  timestamp: string;
  ruleType: 'provider' | 'channel' | 'tool';
  ruleId: string;
  change: 'add' | 'modify' | 'remove';
  before?: unknown;
  after?: unknown;
  source: 'curator' | 'meta' | 'manual' | 'bootstrap';
  reason: string;
  /** Whether this change improved outcomes (verified by Meta^n) */
  verified: boolean;
  /** Rollback possible */
  rollback: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Default model — the bootstrap state for a fresh Symbiote
// ─────────────────────────────────────────────────────────────────────────────

export function createDefaultSarsiModel(): SarsiModel {
  return {
    version: '1.0.0',
    updatedAt: new Date().toISOString(),
    identity: {
      name: 'AVA',
      role: 'Symbiote',
      description: 'Multi-channel AI agent — persistent daemon, real-time interrupts, tool execution.',
      style: 'adaptive',
    },
    goals: [
      { id: 'g1', description: 'Minimize response latency', priority: 'high', metric: 'latency', target: 2000, weight: 0.3 },
      { id: 'g2', description: 'Maximize answer quality', priority: 'high', metric: 'quality', target: 0.9, weight: 0.4 },
      { id: 'g3', description: 'Minimize token cost', priority: 'medium', metric: 'cost', target: 500, weight: 0.2 },
      { id: 'g4', description: 'Maximize tool success rate', priority: 'high', metric: 'tool_success', target: 0.95, weight: 0.1 },
    ],
    providerRules: [
      { id: 'p1', taskType: 'code', provider: 'groq', model: 'llama-3.3-70b', priority: 0.8, rationale: 'Fast + good at code' },
      { id: 'p2', taskType: 'reasoning', provider: 'anthropic', model: 'claude-sonnet-4', priority: 0.9, rationale: 'Best reasoning' },
      { id: 'p3', taskType: 'creative', provider: 'openai', model: 'gpt-4o', priority: 0.8, rationale: 'Good creative output' },
      { id: 'p4', taskType: 'simple_qa', provider: 'groq', model: 'llama-3.3-70b', priority: 0.7, rationale: 'Fast for simple queries' },
      { id: 'p5', taskType: 'long_context', provider: 'anthropic', model: 'claude-sonnet-4', priority: 0.9, conditions: ['context_length > 50000'], rationale: 'Large context window' },
    ],
    channelRules: [
      { id: 'c1', channel: 'discord', behavior: 'markdown_enabled', enabled: true },
      { id: 'c2', channel: 'discord', behavior: 'concise_responses', enabled: true, config: { maxResponseLength: 1800 } },
      { id: 'c3', channel: 'whatsapp', behavior: 'plain_text', enabled: true },
      { id: 'c4', channel: 'whatsapp', behavior: 'voice_transcription', enabled: true },
      { id: 'c5', channel: 'http', behavior: 'full_responses', enabled: true },
    ],
    toolRules: [
      { id: 't1', operation: 'file_read', preferredTool: 'read', maxRetries: 2, timeoutMs: 5000 },
      { id: 't2', operation: 'web_fetch', preferredTool: 'web_fetch', maxRetries: 3, timeoutMs: 15000 },
      { id: 't3', operation: 'shell_exec', preferredTool: 'exec', maxRetries: 1, timeoutMs: 30000 },
      { id: 't4', operation: 'memory_search', preferredTool: 'memory_recall', fallbackTool: 'memory_search', maxRetries: 2, timeoutMs: 10000 },
    ],
    metrics: {
      totalInteractions: 0,
      totalTokensUsed: 0,
      averageLatencyMs: 0,
      toolSuccessRate: 1.0,
      routingAccuracy: 0.5,
      lastUpdated: new Date().toISOString(),
    },
    ruleHistory: [],
    confidence: {
      p1: 0.7, p2: 0.9, p3: 0.8, p4: 0.7, p5: 0.9,
      c1: 1.0, c2: 0.8, c3: 1.0, c4: 1.0, c5: 1.0,
      t1: 0.95, t2: 0.9, t3: 0.95, t4: 0.8,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SARSI Store — disk-backed persistence with atomic writes
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';

export class SarsiStore {
  private filePath: string;
  private backupPath: string;
  private model: SarsiModel | null = null;

  constructor(baseDir: string = '.symbiote') {
    this.filePath = join(baseDir, 'sarsi-model.json');
    this.backupPath = join(baseDir, 'sarsi-model.bak.json');
  }

  /** Load the SARSI model from disk, or create a default one */
  load(): SarsiModel {
    if (this.model) return this.model;

    if (existsSync(this.filePath)) {
      try {
        const raw = readFileSync(this.filePath, 'utf-8');
        this.model = this.validate(raw);
        console.log(`[SARSI] Loaded model v${this.model.version} — ${this.model.providerRules.length} provider rules, ${this.model.ruleHistory.length} history entries`);
        return this.model;
      } catch (err) {
        console.warn(`[SARSI] Failed to load model, falling back to backup: ${err}`);
        if (existsSync(this.backupPath)) {
          try {
            const raw = readFileSync(this.backupPath, 'utf-8');
            this.model = this.validate(raw);
            console.log(`[SARSI] Restored from backup`);
            return this.model;
          } catch {
            console.warn(`[SARSI] Backup also failed, creating fresh model`);
          }
        }
      }
    }

    this.model = createDefaultSarsiModel();
    this.persist();
    console.log(`[SARSI] Created default model`);
    return this.model;
  }

  /** Save the current model atomically (write → backup → replace) */
  save(model: SarsiModel): void {
    this.model = model;
    this.persist();
  }

  /** Get the current model without reloading */
  get(): SarsiModel | null {
    return this.model;
  }

  /** Record a rule change in history and persist */
  recordChange(change: RuleChange): void {
    if (!this.model) this.load();
    this.model!.ruleHistory.push(change);
    // Keep last 500 changes to prevent unbounded growth
    if (this.model!.ruleHistory.length > 500) {
      this.model!.ruleHistory = this.model!.ruleHistory.slice(-500);
    }
    this.persist();
  }

  /** Rollback a specific rule change by ID */
  rollback(changeId: string): boolean {
    if (!this.model) return false;
    const entry = this.model.ruleHistory.find(h => h.id === changeId);
    if (!entry || !entry.rollback) return false;

    // Find the rule and restore it
    switch (entry.ruleType) {
      case 'provider':
        const pIdx = this.model.providerRules.findIndex(r => r.id === entry.ruleId);
        if (entry.change === 'remove' && entry.before) {
          this.model.providerRules.push(entry.before as ProviderRule);
        } else if (entry.change === 'add') {
          if (pIdx >= 0) this.model.providerRules.splice(pIdx, 1);
        } else if (entry.change === 'modify' && entry.before) {
          if (pIdx >= 0) this.model.providerRules[pIdx] = entry.before as ProviderRule;
        }
        break;
      case 'channel':
        const cIdx = this.model.channelRules.findIndex(r => r.id === entry.ruleId);
        if (entry.change === 'remove' && entry.before) {
          this.model.channelRules.push(entry.before as ChannelRule);
        } else if (entry.change === 'add') {
          if (cIdx >= 0) this.model.channelRules.splice(cIdx, 1);
        } else if (entry.change === 'modify' && entry.before) {
          if (cIdx >= 0) this.model.channelRules[cIdx] = entry.before as ChannelRule;
        }
        break;
      case 'tool':
        const tIdx = this.model.toolRules.findIndex(r => r.id === entry.ruleId);
        if (entry.change === 'remove' && entry.before) {
          this.model.toolRules.push(entry.before as ToolRule);
        } else if (entry.change === 'add') {
          if (tIdx >= 0) this.model.toolRules.splice(tIdx, 1);
        } else if (entry.change === 'modify' && entry.before) {
          if (tIdx >= 0) this.model.toolRules[tIdx] = entry.before as ToolRule;
        }
        break;
    }

    this.persist();
    console.log(`[SARSI] Rolled back change ${changeId} (${entry.ruleType} ${entry.ruleId})`);
    return true;
  }

  /** Update metrics snapshot */
  updateMetrics(metrics: Partial<SarsiModel['metrics']>): void {
    if (!this.model) this.load();
    this.model!.metrics = { ...this.model!.metrics, ...metrics, lastUpdated: new Date().toISOString() };
    this.persist();
  }

  /** Adjust confidence for a rule */
  adjustConfidence(ruleId: string, delta: number): void {
    if (!this.model) this.load();
    const current = this.model!.confidence[ruleId] ?? 0.5;
    this.model!.confidence[ruleId] = Math.max(0, Math.min(1, current + delta));
    this.persist();
  }

  /** Serialize the model to a system-prompt-compatible string */
  toSystemPrompt(): string {
    if (!this.model) this.load();
    const m = this.model!;
    return [
      `# SARSI — Self-Aware Routing Identity`,
      `Version: ${m.version} | Updated: ${m.updatedAt}`,
      ``,
      `## Identity`,
      `Name: ${m.identity.name} | Role: ${m.identity.role}`,
      `${m.identity.description}`,
      `Style: ${m.identity.style}`,
      ``,
      `## Active Goals`,
      ...m.goals.map(g => `- [${g.priority}] ${g.description} (target: ${g.target}, weight: ${g.weight})`),
      ``,
      `## Provider Routing Rules`,
      ...m.providerRules.map(r => `- ${r.id}: ${r.taskType} → ${r.provider}/${r.model} (priority: ${r.priority}, confidence: ${m.confidence[r.id] ?? 'N/A'})`),
      ``,
      `## Channel Rules`,
      ...m.channelRules.filter(r => r.enabled).map(r => `- ${r.channel}: ${r.behavior}`),
      ``,
      `## Tool Rules`,
      ...m.toolRules.map(r => `- ${r.operation} → ${r.preferredTool} (timeout: ${r.timeoutMs}ms, retries: ${r.maxRetries})`),
      ``,
      `## Performance Metrics`,
      `Interactions: ${m.metrics.totalInteractions} | Tokens: ${m.metrics.totalTokensUsed} | Avg Latency: ${Math.round(m.metrics.averageLatencyMs)}ms | Tool Success: ${(m.metrics.toolSuccessRate * 100).toFixed(1)}% | Routing Accuracy: ${(m.metrics.routingAccuracy * 100).toFixed(1)}%`,
    ].join('\n');
  }

  /** Validate a raw JSON string as a SARSI model */
  private validate(raw: string): SarsiModel {
    const parsed = JSON.parse(raw);
    if (!parsed.version || !parsed.identity || !parsed.providerRules) {
      throw new Error('Invalid SARSI model: missing required fields');
    }
    return parsed as SarsiModel;
  }

  /** Atomic persist: write to temp → backup existing → replace */
  private persist(): void {
    if (!this.model) return;
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const tmpPath = this.filePath + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(this.model, null, 2), 'utf-8');

    // Backup existing before replacing
    if (existsSync(this.filePath)) {
      copyFileSync(this.filePath, this.backupPath);
    }

    // Atomic rename
    const { renameSync } = require('fs');
    renameSync(tmpPath, this.filePath);
  }
}
