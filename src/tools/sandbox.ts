/**
 * Symbiote — Tool Sandbox
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
 * - ADMIN sessions (verified owners and trusted local operators) get full access
 * - STANDARD sessions get restricted access (no infrastructure modification)
 * - Trusted admin authority is explicitly inherited by its own subagents
 * - Rules are declarative and audited — every denial is logged
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ToolDefinition, ToolExecuteOptions, ToolExecutionOutput } from './types.js';
import type { ToolRegistry } from './registry.js';
import type { ToolExecutor } from '../agent/runner.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export type SessionTier = 'admin' | 'standard' | 'restricted';

export interface SessionContext {
  sessionId: string;
  adapterId: string;       // e.g. 'discord-main', 'whatsapp-main'
  channelType: string;      // 'discord' | 'whatsapp'
  chatType: 'direct' | 'group';
  senderId: string;
  isOwner: boolean;
  inheritedTier?: SessionTier;
  workspaceRoot?: string;
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

export interface SandboxConfig {
  enabled?: boolean;
  ownerAccess?: boolean;
  internalTier?: 'standard' | 'restricted';
  nonOwnerTier?: 'standard' | 'restricted';
}

// ─── Tier Classification ───────────────────────────────────────────────────

const PRIMARY_ADAPTERS = new Set(['discord-main', 'whatsapp-main']);

let sandboxConfig: Required<SandboxConfig> = {
  enabled: false,
  ownerAccess: true,
  internalTier: 'standard',
  nonOwnerTier: 'restricted',
};

export function configureSandbox(config: SandboxConfig | undefined): void {
  sandboxConfig = {
    enabled: config?.enabled === true,
    ownerAccess: config?.ownerAccess !== false,
    internalTier: config?.internalTier === 'restricted' ? 'restricted' : 'standard',
    nonOwnerTier: config?.nonOwnerTier === 'standard' ? 'standard' : 'restricted',
  };
}

export function classifySession(ctx: SessionContext): SessionTier {
  if (ctx.isOwner && sandboxConfig.ownerAccess) {
    return 'admin';
  }
  if (ctx.channelType === 'internal' || ctx.adapterId === 'subagent') {
    if (ctx.inheritedTier === 'admin' && sandboxConfig.ownerAccess) return 'admin';
    if (ctx.inheritedTier) return ctx.inheritedTier;
    if (!sandboxConfig.enabled && sandboxConfig.ownerAccess) return 'admin';
    return sandboxConfig.internalTier;
  }
  return sandboxConfig.nonOwnerTier;
}

// ─── Built-in Rules ────────────────────────────────────────────────────────

function resolvePath(p: string): string {
  return path.resolve(p);
}

/** Symbiote engine directory (absolute) */
const __filename_esm = fileURLToPath(import.meta.url);
const __dirname_esm = path.dirname(__filename_esm);
const ENGINE_ROOT = path.resolve(__dirname_esm, '..', '..');

/**
 * Rule: No modifying Symbiote engine files (src/, dist/, config, package.json)
 * Applies to: edit, write tools for non-admin sessions
 */
const noEngineModification: SandboxRule = {
  name: 'no-engine-modification',
  tools: ['edit', 'write'],
  check: (tool, input, ctx) => {
    // Admin gets full access
    if (classifySession(ctx) === 'admin') return null;

    const filePath = resolvePath(String(input.path ?? ''));
    if (filePath.startsWith(ENGINE_ROOT)) {
      return `Cannot modify Symbiote engine files (${path.relative(ENGINE_ROOT, filePath)}). Only admin sessions can edit engine code.`;
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
      [/systemctl\s+.*(restart|stop|start|kill|daemon-reload).*symbiote/i, 'Cannot control Symbiote service'],
      [/kill\s+(-9\s+)?(\d+|%|\$)/i, 'Cannot kill processes'],
      [/pkill|killall/i, 'Cannot kill processes'],
      
      // Engine file modification via shell
      [/(?:cat|echo|tee|sed|awk)\s+.*>.*symbiote/i, 'Cannot modify Symbiote engine files via shell'],
      [/(?:cp|mv|ln)\s+.*symbiote\/(src|dist)/i, 'Cannot modify Symbiote engine files via shell'],
      [/rm\s+.*symbiote/i, 'Cannot delete Symbiote engine files'],
      
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
      [/cat\s+.*\.private\/credentials/i, 'Cannot read credentials'],
      [/cat\s+.*\.symbiote\/credentials/i, 'Cannot read credentials'],
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
      /\.private\/credentials/,
      /\.symbiote\/credentials/,
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

const projectWorkspaceBoundary: SandboxRule = {
  name: 'project-workspace-boundary',
  tools: ['read', 'write', 'edit', 'exec', 'process_start'],
  check: (tool, input, ctx) => {
    if (!ctx.workspaceRoot || classifySession(ctx) === 'admin') return null;
    const root = path.resolve(ctx.workspaceRoot);
    const key = tool === 'exec' || tool === 'process_start' ? 'workdir' : 'path';
    const requested = typeof input[key] === 'string' ? input[key] as string : root;
    const target = path.resolve(root, requested);
    const relative = path.relative(root, target);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return `Project tools are confined to the assigned workspace (${root}).`;
    }
    let current = root;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try {
        if (fs.lstatSync(current).isSymbolicLink()) {
          return 'Project tools cannot follow symbolic links.';
        }
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code === 'ENOENT') break;
        throw failure;
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

const n8nAdminOnly: SandboxRule = {
  name: 'admin-only-n8n-management',
  tools: '*',
  check: (tool, _input, ctx) => (tool === 'n8n_cloud' || tool.startsWith('n8n_mcp_'))
    && classifySession(ctx) !== 'admin'
    ? 'Full n8n API access is only available in admin sessions'
    : null,
};

/** All built-in rules */
const BUILTIN_RULES: SandboxRule[] = [
  noEngineModification,
  noDangerousCommands,
  noSensitiveReads,
  projectWorkspaceBoundary,
  restrictedLimitations,
  noCrossChannelToOwner,
  n8nAdminOnly,
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
    if (this.tier !== 'admin') {
      const visibleToNonAdmin = all.filter(t =>
        t.name !== 'computer_use' && t.name !== 'workspace_manage'
        && t.name !== 'n8n_cloud' && !t.name.startsWith('n8n_mcp_'),
      );
      if (this.tier !== 'restricted') return visibleToNonAdmin;
      // Restricted sessions don't even see dangerous tools
      const hiddenTools = new Set(['exec', 'process_start', 'process_kill', 'write', 'edit', 'spawn', 'message', 'delete_message']);
      return visibleToNonAdmin.filter(t => !hiddenTools.has(t.name));
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
  async execute(name: string, input: Record<string, unknown>, options?: ToolExecuteOptions): Promise<string> {
    const denial = this.validate(name, input);
    if (denial) return JSON.stringify({ error: denial, sandbox: true });
    if (name === 'computer_use' && this.tier !== 'admin') {
      const reason = 'Native desktop control is only available in admin sessions';
      logDenial({
        timestamp: Date.now(),
        sessionId: this.ctx.sessionId,
        tier: this.tier,
        tool: name,
        rule: 'admin-only-desktop-control',
        reason,
        input: this.sanitizeInput(input),
      });
      return JSON.stringify({ error: reason, sandbox: true });
    }
    if (name === 'workspace_manage' && this.tier !== 'admin') {
      const reason = 'Project and agent creation is only available in admin sessions';
      logDenial({
        timestamp: Date.now(),
        sessionId: this.ctx.sessionId,
        tier: this.tier,
        tool: name,
        rule: 'admin-only-workspace-management',
        reason,
        input: this.sanitizeInput(input),
      });
      return JSON.stringify({ error: reason, sandbox: true });
    }

    // Project commands default to the assigned workspace unless the caller gives a checked path.
    const scopedInput = { ...input };
    if (this.ctx.workspaceRoot && ['exec', 'process_start'].includes(name)
      && typeof scopedInput.workdir !== 'string') {
      scopedInput.workdir = this.ctx.workspaceRoot;
    }
    return this.inner.execute(name, scopedInput, {
      ...options,
      sessionId: this.ctx.sessionId,
      sessionTier: this.tier,
    });
  }

  async executeWithImages(name: string, input: Record<string, unknown>, options?: ToolExecuteOptions): Promise<ToolExecutionOutput> {
    const denial = this.validate(name, input);
    if (denial) return { text: JSON.stringify({ error: denial, sandbox: true }), isError: true };
    if (name === 'computer_use' && this.tier !== 'admin') {
      const reason = 'Native desktop control is only available in admin sessions';
      logDenial({
        timestamp: Date.now(),
        sessionId: this.ctx.sessionId,
        tier: this.tier,
        tool: name,
        rule: 'admin-only-desktop-control',
        reason,
        input: this.sanitizeInput(input),
      });
      return { text: JSON.stringify({ error: reason, sandbox: true }), isError: true };
    }
    if (name === 'workspace_manage' && this.tier !== 'admin') {
      const reason = 'Project and agent creation is only available in admin sessions';
      logDenial({
        timestamp: Date.now(),
        sessionId: this.ctx.sessionId,
        tier: this.tier,
        tool: name,
        rule: 'admin-only-workspace-management',
        reason,
        input: this.sanitizeInput(input),
      });
      return { text: JSON.stringify({ error: reason, sandbox: true }), isError: true };
    }
    const scopedInput = { ...input };
    if (this.ctx.workspaceRoot && ['exec', 'process_start'].includes(name)
      && typeof scopedInput.workdir !== 'string') {
      scopedInput.workdir = this.ctx.workspaceRoot;
    }
    const executionOptions = { ...options, sessionId: this.ctx.sessionId, sessionTier: this.tier };
    if (this.inner.executeWithImages) return this.inner.executeWithImages(name, scopedInput, executionOptions);
    return { text: await this.inner.execute(name, scopedInput, executionOptions) };
  }

  /** Validate a command before it is submitted to a long-lived project shell. */
  validate(name: string, input: Record<string, unknown>): string | null {
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
          return denial;
        }
      }
    }
    return null;
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
