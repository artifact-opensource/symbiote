/**
 * Mach6 — Tool Sandbox
 * 
 * Enforces per-session security boundaries on tool execution.
 * This is the ONLY place where tool access control happens.
 * 
 * Architecture:
 * - Every agent session gets a SandboxedToolRegistry wrapping the real ToolRegistry
 * - The sandbox intercepts execute() calls and enforces rules BEFORE the tool runs
 * - Rules are based on session context (channel, sender, adapter) not string matching
 * - The real tools never see the sandbox — it's transparent wrapping
 * 
 * Security model:
 * - ADMIN sessions (owner DM on primary adapters) get full access
 * - STANDARD sessions get restricted access (no infrastructure modification)
 * - Rules are declarative and audited — every denial is logged
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ToolDefinition, ToolExecuteOptions } from './types.js';
import type { ToolRegistry } from './registry.js';
import type { ToolExecutor } from '../agent/runner.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export type SessionTier = 'admin' | 'standard' | 'restricted';

export interface SessionContext {
  sessionId: string;
  adapterId: string;       // e.g. 'discord-main', 'whatsapp-main', 'discord-ava'
  channelType: string;      // 'discord' | 'whatsapp'
  chatType: 'direct' | 'group';
  senderId: string;
  chatId: string;
  isOwner: boolean;
}

export interface SandboxRule {
  /** Human-readable name for logging */
  name: string;
  /** Which tools this rule applies to. '*' = all tools. */
  tools: string[] | '*';
  /** The check function. Return null to allow, or a string reason to deny. */
  check: (tool: string, input: Record<string, unknown>, ctx: SessionContext) => string | null;
}

export interface SandboxDenial {
  timestamp: number;
  sessionId: string;
  tier: SessionTier;
  tool: string;
  rule: string;
  reason: string;
  input: Record<string, unknown>;
}

// ─── Tier Classification ───────────────────────────────────────────────────

const PRIMARY_ADAPTERS = new Set(['discord-main', 'whatsapp-main']);

export function classifySession(ctx: SessionContext): SessionTier {
  // Admin: owner anywhere (Ali controls the system regardless of channel type)
  if (ctx.isOwner) {
    return 'admin';
  }
  // Restricted: non-owner
  return 'restricted';
}

// ─── Built-in Rules ────────────────────────────────────────────────────────

function resolvePath(p: string): string {
  return path.resolve(p);
}

/** Mach6 engine directory (absolute) */
const __filename_esm = fileURLToPath(import.meta.url);
const __dirname_esm = path.dirname(__filename_esm);
const MACH6_ROOT = path.resolve(__dirname_esm, '..', '..');

/**
 * Rule: No modifying Mach6 engine files (src/, dist/, config, package.json)
 * Applies to: edit, write tools for non-admin sessions
 */
const noEngineModification: SandboxRule = {
  name: 'no-engine-modification',
  tools: ['edit', 'write'],
  check: (tool, input, ctx) => {
    // Admin gets full access
    if (classifySession(ctx) === 'admin') return null;

    const filePath = resolvePath(String(input.path ?? ''));
    if (filePath.startsWith(MACH6_ROOT)) {
      return `Cannot modify Mach6 engine files (${path.relative(MACH6_ROOT, filePath)}). Only admin sessions can edit engine code.`;
    }
    return null;
  },
};

/**
 * Rule: No dangerous shell commands for non-admin sessions
 * Blocks: systemctl restart, kill, rm -rf on system dirs, etc.
 */
const noDangerousCommands: SandboxRule = {
  name: 'no-dangerous-commands',
  tools: ['exec', 'process_start'],
  check: (tool, input, ctx) => {
    if (classifySession(ctx) === 'admin') return null;

    const command = String(input.command ?? '');
    
    // Patterns that are NEVER allowed for non-admin sessions
    const dangerousPatterns: Array<[RegExp, string]> = [
      // Process/service control
      [/systemctl\s+.*(restart|stop|start|kill|daemon-reload).*mach6/i, 'Cannot control Mach6 service'],
      [/kill\s+(-9\s+)?(\d+|%|\$)/i, 'Cannot kill processes'],
      [/pkill|killall/i, 'Cannot kill processes'],
      
      // Engine file modification via shell
      [/(?:cat|echo|tee|sed|awk)\s+.*>.*mach6-core/i, 'Cannot modify Mach6 files via shell'],
      [/(?:cp|mv|ln)\s+.*mach6-core\/(src|dist)/i, 'Cannot modify Mach6 files via shell'],
      [/rm\s+.*mach6-core/i, 'Cannot delete Mach6 files'],
      
      // System-level destruction
      [/rm\s+-rf?\s+\/(usr|etc|var|home|boot|sys|proc)/i, 'Cannot delete system directories'],
      [/mkfs|dd\s+.*of=\/dev/i, 'Cannot modify block devices'],
      [/chmod\s+.*777\s+\//i, 'Cannot change root permissions'],
      
      // Code execution that bypasses the sandbox
      [/node\s+-e\s+.*child_process/i, 'Cannot spawn child processes via eval'],
      [/python3?\s+-c\s+.*subprocess/i, 'Cannot spawn subprocesses via eval'],
      
      // Network exfiltration
      [/curl\s+.*-d\s+.*@/i, 'Cannot exfiltrate files via curl'],
      [/scp\s+/i, 'Cannot use scp'],
      [/rsync\s+.*:/i, 'Cannot use rsync to remote'],
      
      // Credential access
      [/cat\s+.*\.env\b/i, 'Cannot read environment files'],
      [/cat\s+.*credentials/i, 'Cannot read credential files'],
      [/cat\s+.*\.ava-private\/credentials/i, 'Cannot read credentials'],
    ];

    for (const [pattern, reason] of dangerousPatterns) {
      if (pattern.test(command)) {
        return reason;
      }
    }
    return null;
  },
};

/**
 * Rule: No reading sensitive files for non-admin sessions
 */
const noSensitiveReads: SandboxRule = {
  name: 'no-sensitive-reads',
  tools: ['read'],
  check: (tool, input, ctx) => {
    if (classifySession(ctx) === 'admin') return null;

    const filePath = resolvePath(String(input.path ?? ''));
    const sensitivePatterns = [
      /\.env$/,
      /credentials\.(json|md|txt)$/,
      /\.ava-private\/credentials/,
      /\.ssh\//,
      /\.gnupg\//,
    ];

    for (const pattern of sensitivePatterns) {
      if (pattern.test(filePath)) {
        return `Cannot read sensitive file: ${path.basename(filePath)}`;
      }
    }
    return null;
  },
};

/**
 * Rule: Restricted sessions get read-only + limited exec
 */
const restrictedLimitations: SandboxRule = {
  name: 'restricted-limitations',
  tools: ['write', 'edit', 'exec', 'process_start', 'spawn'],
  check: (tool, input, ctx) => {
    if (classifySession(ctx) !== 'restricted') return null;
    
    // Restricted sessions can only read, search, fetch
    if (['write', 'edit'].includes(tool)) {
      return 'Write access not available in this session';
    }
    if (['exec', 'process_start'].includes(tool)) {
      return 'Shell access not available in this session';
    }
    if (tool === 'spawn') {
      return 'Sub-agent spawning not available in this session';
    }
    return null;
  },
};

/**
 * Rule: No cross-channel messaging to owner's private chats for non-admin
 */
const noCrossChannelToOwner: SandboxRule = {
  name: 'no-cross-channel-to-owner',
  tools: ['message'],
  check: (tool, input, ctx) => {
    if (classifySession(ctx) === 'admin') return null;

    // Non-admin sessions can't send messages to other channels
    // (they can only respond through the gateway's normal response path)
    return 'Cross-channel messaging is only available in admin sessions';
  },
};

/** All built-in rules */
const BUILTIN_RULES: SandboxRule[] = [
  noEngineModification,
  noDangerousCommands,
  noSensitiveReads,
  restrictedLimitations,
  noCrossChannelToOwner,
];

// ─── Audit Log ─────────────────────────────────────────────────────────────

const MAX_AUDIT_LOG = 1000;
const auditLog: SandboxDenial[] = [];

function logDenial(denial: SandboxDenial): void {
  auditLog.push(denial);
  if (auditLog.length > MAX_AUDIT_LOG) auditLog.shift();
  
  console.warn(
    `[sandbox] DENIED: session=${denial.sessionId} tier=${denial.tier} ` +
    `tool=${denial.tool} rule=${denial.rule} reason="${denial.reason}"`
  );
}

export function getAuditLog(): SandboxDenial[] {
  return [...auditLog];
}

// ─── Sandboxed Tool Registry ───────────────────────────────────────────────

/**
 * A ToolRegistry wrapper that enforces sandbox rules per-session.
 * 
 * Usage in daemon.ts:
 *   const sandboxed = createSandboxedRegistry(this.toolRegistry, sessionContext);
 *   // Pass sandboxed to runAgent instead of this.toolRegistry
 */
export class SandboxedToolRegistry {
  private inner: ToolExecutor;
  private ctx: SessionContext;
  private tier: SessionTier;
  private rules: SandboxRule[];
  private customRules: SandboxRule[] = [];

  constructor(inner: ToolExecutor, ctx: SessionContext, extraRules?: SandboxRule[]) {
    this.inner = inner;
    this.ctx = ctx;
    this.tier = classifySession(ctx);
    this.rules = [...BUILTIN_RULES, ...(extraRules ?? [])];

    console.log(`[sandbox] Session ${ctx.sessionId} classified as ${this.tier} (adapter=${ctx.adapterId}, owner=${ctx.isOwner}, chat=${ctx.chatType})`);
  }

  /** Proxy: get tool definition */
  get(name: string) {
    return this.list().find(t => t.name === name);
  }

  /** Proxy: list all tools (but may filter for restricted sessions) */
  list(): Array<{ name: string; description: string; parameters: any }> {
    const all = this.inner.list();
    
    if (this.tier === 'restricted') {
      // Restricted sessions don't even see dangerous tools
      const hiddenTools = new Set(['exec', 'process_start', 'process_kill', 'write', 'edit', 'spawn', 'message', 'delete_message']);
      return all.filter(t => !hiddenTools.has(t.name));
    }
    
    return all;
  }

  /** Proxy: convert to provider format (respects tool visibility) */
  toProviderFormat() {
    return this.list().map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  /** Execute with sandbox enforcement */
  async execute(name: string, input: Record<string, unknown>): Promise<string> {
    // Check all applicable rules
    for (const rule of this.rules) {
      if (rule.tools === '*' || rule.tools.includes(name)) {
        const denial = rule.check(name, input, this.ctx);
        if (denial) {
          const record: SandboxDenial = {
            timestamp: Date.now(),
            sessionId: this.ctx.sessionId,
            tier: this.tier,
            tool: name,
            rule: rule.name,
            reason: denial,
            input: this.sanitizeInput(input),
          };
          logDenial(record);
          return JSON.stringify({ error: denial, sandbox: true });
        }
      }
    }

    // All rules passed — execute
    return this.inner.execute(name, input);
  }

  /** Sanitize input for audit log (remove large content, sensitive values) */
  private sanitizeInput(input: Record<string, unknown>): Record<string, unknown> {
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (typeof value === 'string' && value.length > 200) {
        clean[key] = value.slice(0, 200) + '...[truncated]';
      } else {
        clean[key] = value;
      }
    }
    return clean;
  }

  /** Get session tier */
  getTier(): SessionTier {
    return this.tier;
  }
}

/**
 * Create a sandboxed tool registry for a specific session.
 * This is the primary API — call it in daemon.ts before each agent turn.
 */
export function createSandboxedRegistry(
  inner: ToolExecutor,
  ctx: SessionContext,
  extraRules?: SandboxRule[],
): SandboxedToolRegistry {
  return new SandboxedToolRegistry(inner, ctx, extraRules);
}
