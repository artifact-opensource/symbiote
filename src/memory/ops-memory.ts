import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type OpsCategory =
  | 'process'
  | 'service'
  | 'filesystem'
  | 'repository'
  | 'build'
  | 'memory'
  | 'browser'
  | 'network'
  | 'shell'
  | 'tool';

export interface OpsObservation {
  id: string;
  interactionId: string;
  workspace: string;
  observedAt: string;
  expiresAt: string;
  tool: string;
  category: OpsCategory;
  outcome: 'succeeded' | 'failed';
  failureClass?: 'timeout' | 'not_found' | 'permission' | 'rate_limit' | 'network' | 'exit' | 'other';
  evidence: 'completed_tool_execution';
}

interface OpsMemoryState {
  version: 1;
  observations: OpsObservation[];
}

interface ToolOutcome {
  name: string;
  input: unknown;
  result: string;
}

const MAX_OBSERVATIONS = 1000;
const VOLATILE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const STABLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FAILURE_PATTERNS = /^Error\b|"is_error":\s*true|"error":|Exit code: [1-9]/i;

const OPERATIONAL_QUERY = /\b(status|current|currently|running|offline|online|service|daemon|gateway|process|file|directory|folder|read|exec|shell|command|memory|persist|quota|rate.?limit|discord|browser|computer|tool|error|failed|failure|restart|install|installed)\b/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asToolInput(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function classifyCategory(tool: string, input: Record<string, unknown>): OpsCategory | null {
  const name = tool.toLowerCase();
  if (name === 'exec') {
    const command = String(input.command ?? '');
    if (/\b(Get-Service|sc(?:\.exe)?\s+query|systemctl\s+(?:status|is-active))\b/i.test(command)) return 'service';
    if (/\b(Get-Process|Win32_Process|tasklist|pgrep|ps\s+(?:-e|aux))\b/i.test(command)) return 'process';
    if (/\b(Test-Path|Get-ChildItem|Get-Item|stat\b|find\b|(?:^|\s)(?:dir|ls)(?:\s|$))\b/i.test(command)) return 'filesystem';
    if (/\bgit\s+(?:status|log|show|diff)\b/i.test(command)) return 'repository';
    if (/\b(npm|npx|node\s+--test|tsc)\b/i.test(command)) return 'build';
    if (/\b(curl|Invoke-WebRequest|Invoke-RestMethod|ping|nslookup)\b/i.test(command)) return 'network';
    return 'shell';
  }
  if (/^(process_list|process_poll|process_start|process_kill)$/.test(name)) return 'process';
  if (/^(read|write|edit)$/.test(name)) return 'filesystem';
  if (/^(memory_|vdb_|comb_|persona_digest)/.test(name)) return 'memory';
  if (/^(web_|cua_)/.test(name)) return 'browser';
  if (/^(message|typing|presence|delete_message|mark_read)$/.test(name)) return 'tool';
  return null;
}

function failureClass(result: string): OpsObservation['failureClass'] {
  if (/timed?\s*out|timeout/i.test(result)) return 'timeout';
  if (/not found|no such file|does not exist/i.test(result)) return 'not_found';
  if (/permission denied|access is denied|unauthorized|forbidden/i.test(result)) return 'permission';
  if (/429|rate.?limit|quota/i.test(result)) return 'rate_limit';
  if (/econnreset|econnrefused|network|socket|fetch failed/i.test(result)) return 'network';
  if (/exit code:\s*[1-9]/i.test(result)) return 'exit';
  return 'other';
}

function ttlFor(category: OpsCategory): number {
  if (category === 'process' || category === 'service' || category === 'network') return VOLATILE_TTL_MS;
  if (category === 'memory' || category === 'repository' || category === 'build') return STABLE_TTL_MS;
  return DEFAULT_TTL_MS;
}

function isObservation(value: unknown): value is OpsObservation {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && typeof value.interactionId === 'string'
    && typeof value.workspace === 'string'
    && typeof value.observedAt === 'string'
    && typeof value.expiresAt === 'string'
    && typeof value.tool === 'string'
    && typeof value.category === 'string'
    && ['process', 'service', 'filesystem', 'repository', 'build', 'memory', 'browser', 'network', 'shell', 'tool'].includes(value.category)
    && (value.outcome === 'succeeded' || value.outcome === 'failed')
    && value.evidence === 'completed_tool_execution';
}

function categoriesForQuery(query: string): Set<OpsCategory> {
  const categories = new Set<OpsCategory>();
  if (/\b(service|daemon|gateway)\b/i.test(query)) categories.add('service');
  if (/\b(process|running|offline|online)\b/i.test(query)) categories.add('process');
  if (/\b(file|directory|folder|read|write|edit)\b/i.test(query)) categories.add('filesystem');
  if (/\b(repository|git|commit|branch)\b/i.test(query)) categories.add('repository');
  if (/\b(build|test|npm|typescript|compile)\b/i.test(query)) categories.add('build');
  if (/\b(memory|persist|comb|vdb|recall)\b/i.test(query)) categories.add('memory');
  if (/\b(browser|computer|cua|web)\b/i.test(query)) categories.add('browser');
  if (/\b(quota|rate.?limit|discord|network|connection)\b/i.test(query)) categories.add('network');
  if (/\b(exec|shell|command|tool|error|failed|failure|restart|install|installed|status|current|currently)\b/i.test(query)) {
    for (const category of ['process', 'service', 'filesystem', 'repository', 'build', 'memory', 'browser', 'network', 'shell', 'tool'] as const) {
      categories.add(category);
    }
  }
  return categories;
}

/**
 * Durable, bounded history of completed operational tool executions.
 * It intentionally stores no tool arguments, command text, result bodies, or user text.
 */
export class OpsMemory {
  private readonly statePath: string;
  private readonly workspace: string;

  constructor(statePath: string, workspace = process.env.SYMBIOTE_WORKSPACE ?? process.cwd()) {
    this.statePath = path.resolve(statePath);
    this.workspace = path.resolve(workspace);
  }

  recordToolOutcomes(interactionId: string, toolCalls: ToolOutcome[]): number {
    if (!interactionId) throw new Error('Ops Memory requires an interaction ID.');
    const state = this.load();
    const existingIds = new Set(state.observations.map(observation => observation.id));
    const observedAt = new Date();
    const additions: OpsObservation[] = [];

    toolCalls.forEach((call, index) => {
      const input = asToolInput(call.input);
      const category = classifyCategory(call.name, input);
      if (!category) return;

      const id = `${interactionId}:${index}`;
      if (existingIds.has(id)) return;

      const failed = FAILURE_PATTERNS.test(call.result);
      additions.push({
        id,
        interactionId,
        workspace: this.workspace,
        observedAt: observedAt.toISOString(),
        expiresAt: new Date(observedAt.getTime() + ttlFor(category)).toISOString(),
        tool: call.name,
        category,
        outcome: failed ? 'failed' : 'succeeded',
        ...(failed ? { failureClass: failureClass(call.result) } : {}),
        evidence: 'completed_tool_execution',
      });
    });

    if (additions.length === 0) return 0;
    state.observations = [...state.observations, ...additions].slice(-MAX_OBSERVATIONS);
    this.persist(state);
    return additions.length;
  }

  formatRelevant(query: string, limit = 4): string | null {
    if (!OPERATIONAL_QUERY.test(query)) return null;
    const categories = categoriesForQuery(query);
    if (categories.size === 0) return null;

    const now = Date.now();
    const observations = this.load().observations
      .filter(observation => observation.workspace === this.workspace
        && categories.has(observation.category)
        && Date.parse(observation.expiresAt) > now)
      .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))
      .slice(0, limit);
    if (observations.length === 0) return null;

    const lines = [
      '[OPS MEMORY — historical execution evidence, not live status]',
      'These entries report only whether a tool execution returned success/error. They do not prove the current state of a process, service, file, quota, or external system. Verify volatile state now before relying on it.',
    ];
    for (const observation of observations) {
      const observedAt = new Date(observation.observedAt).toISOString();
      const expiresAt = new Date(observation.expiresAt).toISOString();
      const failure = observation.failureClass ? `, failure=${observation.failureClass}` : '';
      lines.push(`- ${observation.category}/${observation.tool}: ${observation.outcome}${failure}; observed=${observedAt}; evidence=${observation.evidence}; expires=${expiresAt}.`);
    }
    return lines.join('\n');
  }

  private load(): OpsMemoryState {
    if (!fs.existsSync(this.statePath)) return { version: 1, observations: [] };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as OpsMemoryState;
      if (parsed.version !== 1 || !Array.isArray(parsed.observations) || !parsed.observations.every(isObservation)) {
        throw new Error('unsupported or malformed Ops Memory state');
      }
      return parsed;
    } catch (error) {
      throw new Error(`Failed to load Ops Memory from ${this.statePath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  private persist(state: OpsMemoryState): void {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    const tempPath = `${this.statePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = fs.openSync(tempPath, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(state), 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(tempPath, this.statePath);
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(tempPath); } catch { /* Preserve the primary persistence error. */ }
      throw new Error(`Failed to persist Ops Memory to ${this.statePath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
}

let singleton: OpsMemory | null = null;

export function getOpsMemory(): OpsMemory | null {
  if (process.env.SYMBIOTE_OPS_MEMORY === '0') return null;
  if (!singleton) {
    const workspace = path.resolve(process.env.SYMBIOTE_WORKSPACE ?? process.cwd());
    singleton = new OpsMemory(path.join(workspace, '.symbiote', 'ops-memory.json'), workspace);
  }
  return singleton;
}

export function resetOpsMemoryForTests(): void {
  singleton = null;
}
