import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface HeartbeatDecision {
  action: 'execute' | 'idle';
  task?: string;
}

interface HeartbeatTaskRecord {
  status: 'started' | 'completed' | 'failed';
  updatedAt: number;
  error?: string;
}

interface HeartbeatLedger {
  version: 1;
  tasks: Record<string, HeartbeatTaskRecord>;
  blockedScopeHash?: string;
}

interface SubAgentRecord {
  taskId: string;
  task: string;
  pid: number;
  startedAt: number;
  completedAt?: number;
  status: 'running' | 'completed' | 'failed' | 'killed';
  error?: string;
}

interface SubAgentLedger {
  version: 1;
  agents: Record<string, SubAgentRecord>;
}

interface VdbDocument {
  id: string;
  content: string;
  source: string;
  metadata?: Record<string, unknown>;
  vector?: number[];
}

interface VdbIndex {
  version: number;
  documents: Record<string, { offset: number; length: number; source: string }>;
  lastUpdated: number;
}

const MAX_TASKS = 100;
const MAX_TASK_LENGTH = 2_000;
const IDLE_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const HEARTBEAT_TASKS_HEADING = /^##\s+Authorized Tasks\s*$/im;

function ledgerPath(workspace: string): string {
  return path.join(path.resolve(workspace), '.agents', 'heartbeat', 'state.json');
}

function readHeartbeatDocument(workspace: string): string | null {
  const filePath = path.join(path.resolve(workspace), 'HEARTBEAT.md');
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function readLedger(filePath: string): HeartbeatLedger {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Heartbeat task ledger is malformed: ${filePath}`);
    }
    const value = parsed as Partial<HeartbeatLedger>;
    if (value.version !== 1 || !value.tasks || typeof value.tasks !== 'object' || Array.isArray(value.tasks)) {
      throw new Error(`Heartbeat task ledger is malformed: ${filePath}`);
    }
    if (value.blockedScopeHash !== undefined && !/^[a-f0-9]{64}$/.test(value.blockedScopeHash)) {
      throw new Error(`Heartbeat task ledger is malformed: ${filePath}`);
    }
    for (const [key, task] of Object.entries(value.tasks)) {
      if (!/^[a-f0-9]{64}$/.test(key)
        || !task || typeof task !== 'object'
        || !['started', 'completed', 'failed'].includes(task.status)
        || !Number.isFinite(task.updatedAt)
        || (task.error !== undefined && typeof task.error !== 'string')) {
        throw new Error(`Heartbeat task ledger is malformed: ${filePath}`);
      }
    }
    return value as HeartbeatLedger;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, tasks: {} };
    throw error;
  }
}

function writeLedger(filePath: string, ledger: HeartbeatLedger): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(ledger, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try { fs.rmSync(temporaryPath, { force: true }); } catch { /* Preserve the original write error. */ }
    throw error;
  }
}

export function parseAuthorizedHeartbeatTasks(contents: string): string[] {
  const markdown = markdownContent(contents);
  const heading = HEARTBEAT_TASKS_HEADING.exec(markdown);
  if (!heading || heading.index === undefined) return [];

  const sectionStart = heading.index + heading[0].length;
  const nextHeading = /^##\s+/m.exec(markdown.slice(sectionStart));
  const section = markdown.slice(
    sectionStart,
    nextHeading ? sectionStart + nextHeading.index : undefined,
  );
  const tasks = [...section.matchAll(/^\s*-\s*\[\s\]\s+(.+?)\s*$/gm)]
    .map(match => match[1].trim())
    .filter(Boolean);

  if (tasks.length > MAX_TASKS) {
    throw new Error(`HEARTBEAT.md may contain at most ${MAX_TASKS} authorized tasks.`);
  }
  for (const task of tasks) {
    if (task.length > MAX_TASK_LENGTH) {
      throw new Error(`An authorized heartbeat task exceeds ${MAX_TASK_LENGTH} characters.`);
    }
  }
  return [...new Set(tasks)];
}

function markdownContent(contents: string): string {
  const withoutComments = contents.replace(/<!--[\s\S]*?-->/g, comment =>
    comment.replace(/[^\r\n]/g, ' '),
  );
  let fence: { character: string; length: number } | undefined;
  return withoutComments.split(/\r?\n/).filter(line => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (!fence && marker) {
      fence = { character: marker[0], length: marker.length };
      return false;
    }
    if (fence) {
      const closingFence = /^\s*(`{3,}|~{3,})\s*$/.exec(line)?.[1];
      if (closingFence && closingFence[0] === fence.character && closingFence.length >= fence.length) {
        fence = undefined;
      }
      return false;
    }
    return true;
  }).join('\n');
}

export function heartbeatTaskKey(task: string): string {
  return createHash('sha256').update(task).digest('hex');
}

export function describeHeartbeatError(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<object>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current) && parts.length < 4) {
    seen.add(current);
    const value = current as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown };
    const name = typeof value.name === 'string' ? value.name : 'Error';
    const message = typeof value.message === 'string' ? value.message : String(current);
    const code = typeof value.code === 'string' ? ` [${value.code}]` : '';
    parts.push(`${name}${code}: ${message}`);
    current = value.cause;
  }
  if (parts.length === 0) parts.push(String(error));
  return parts.join(' <- ')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,})\b/g, '[redacted]')
    .slice(0, 1_000);
}

export function parseHeartbeatDecision(output: string, authorizedTasks: readonly string[]): HeartbeatDecision {
  let parsed: unknown;

  const tryParse = (text: string): unknown => JSON.parse(text.trim());

  try {
    parsed = tryParse(output);
  } catch {
    // Providers sometimes wrap JSON in markdown fences or add explanatory text.
    // Strip fences and extract the first { ... } block before failing closed.
    const fenceStripped = output.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
    try {
      parsed = tryParse(fenceStripped);
    } catch {
      const braceStart = fenceStripped.indexOf('{');
      const braceEnd = fenceStripped.lastIndexOf('}');
      if (braceStart >= 0 && braceEnd > braceStart) {
        try {
          parsed = tryParse(fenceStripped.slice(braceStart, braceEnd + 1));
        } catch {
          throw new Error('Heartbeat decision was not valid JSON; no automation was actuated.');
        }
      } else {
        throw new Error('Heartbeat decision was not valid JSON; no automation was actuated.');
      }
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Heartbeat decision must be a JSON object; no automation was actuated.');
  }

  const decision = parsed as Record<string, unknown>;
  if (decision.action === 'idle' && Object.keys(decision).length === 1) {
    return { action: 'idle' };
  }
  if (decision.action !== 'execute'
    || Object.keys(decision).length !== 2
    || typeof decision.task !== 'string'
    || !authorizedTasks.includes(decision.task)) {
    throw new Error('Heartbeat decision did not select an exact authorized task; no automation was actuated.');
  }
  return { action: 'execute', task: decision.task };
}

export function selectHeartbeatTask(tasks: readonly string[]): string | null {
  return tasks.find(task => task.trim().length > 0) ?? null;
}

export function readAvailableHeartbeatTasks(workspace: string): string[] {
  const contents = readHeartbeatDocument(workspace);
  if (contents === null) return [];
  const scopeHash = createHash('sha256').update(contents).digest('hex');
  const tasks = parseAuthorizedHeartbeatTasks(contents);
  const filePath = ledgerPath(workspace);
  const ledger = readLedger(filePath);
  if (ledger.blockedScopeHash) {
    if (ledger.blockedScopeHash === scopeHash) return [];
    delete ledger.blockedScopeHash;
    writeLedger(filePath, ledger);
  }
  return tasks.filter(task => !ledger.tasks[heartbeatTaskKey(task)]);
}

export function heartbeatScopeHash(workspace: string): string {
  const contents = readHeartbeatDocument(workspace);
  return createHash('sha256').update(contents ?? '<missing HEARTBEAT.md>').digest('hex');
}
export function pauseHeartbeatAutomation(workspace: string): void {
  const filePath = ledgerPath(workspace);
  const ledger = readLedger(filePath);
  ledger.blockedScopeHash = heartbeatScopeHash(workspace);
  writeLedger(filePath, ledger);
}
export function recordHeartbeatTask(
  workspace: string,
  task: string,
  status: HeartbeatTaskRecord['status'],
  error?: string,
): void {
  const filePath = ledgerPath(workspace);
  const ledger = readLedger(filePath);
  ledger.tasks[heartbeatTaskKey(task)] = {
    status,
    updatedAt: Date.now(),
    ...(error ? { error: describeHeartbeatError(error).slice(0, 500) } : {}),
  };
  writeLedger(filePath, ledger);
}
