// Symbiote — Session lifecycle manager

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Message } from '../providers/types.js';
import type { SessionRoute } from '../channels/types.js';
import type { Session, SessionSummary, SessionMetadata } from './types.js';
import { stripBlinkControlMessages } from '../agent/blink.js';
import { deriveConversationTitle } from './title.js';

const renameRetryDelay = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

export class SessionPersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SessionPersistenceError';
  }
}

// Windows antivirus/indexers may temporarily lock a file during rename.
function atomicRename(oldPath: string, newPath: string): void {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.renameSync(oldPath, newPath);
      return;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (attempt >= 4 || (err.code !== 'EPERM' && err.code !== 'EBUSY')) throw err;
      Atomics.wait(renameRetryDelay, 0, 0, 25 * (attempt + 1));
    }
  }
}

export function atomicWriteFile(destination: string, content: string, label: string, logScope = 'sessions'): void {
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(temporary, content, { flag: 'wx' });
    atomicRename(temporary, destination);
  } catch (error) {
    const persistenceError = new SessionPersistenceError(
      `Failed to persist ${label} at ${destination}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
    console.error(`[${logScope}] ${persistenceError.message}`);
    try {
      fs.unlinkSync(temporary);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[${logScope}] Could not clean up temporary file ${temporary}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
      }
    }
    throw persistenceError;
  }
}

function unlinkAndVerify(filePath: string, label: string): boolean {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    const persistenceError = new SessionPersistenceError(
      `Failed to remove ${label} at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
    console.error(`[sessions] ${persistenceError.message}`);
    throw persistenceError;
  }
  if (fs.existsSync(filePath)) {
    const persistenceError = new SessionPersistenceError(`Failed to verify removal of ${label} at ${filePath}.`);
    console.error(`[sessions] ${persistenceError.message}`);
    throw persistenceError;
  }
  return true;
}


const DEFAULT_DIR = '.sessions';
const DEFAULT_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

export function resolveSessionDirectory(workspace: string): string {
  return path.join(path.resolve(workspace), DEFAULT_DIR);
}

export function createWorkspaceSessionManager(workspace: string, configuredDirectory?: string): SessionManager {
  const root = resolveSessionDirectory(workspace);
  return new SessionManager(
    root,
    undefined,
    [configuredDirectory, path.join(path.resolve(workspace), '.session')].filter((directory): directory is string => Boolean(directory)),
    workspace,
  );
}

/**
 * Sanitize message history to remove orphaned tool results/calls.
 * A tool result (role=tool with tool_call_id) is orphaned if no preceding
 * assistant message has a matching tool_call. This prevents Anthropic API 400 errors.
 */
function sanitizeToolPairs(messages: Message[]): Message[] {
  const precedingToolCallIds = new Set<string>();
  const filtered: Message[] = [];
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      precedingToolCallIds.clear();
      for (const tc of msg.tool_calls ?? []) precedingToolCallIds.add(tc.id);
      if (typeof msg.content !== 'string') {
        for (const block of msg.content) {
          if (block.type === 'tool_use' && block.id) precedingToolCallIds.add(block.id);
        }
      }
    } else if (msg.role !== 'tool' && (typeof msg.content === 'string' || !msg.content.some(block => block.type === 'tool_result'))) {
      precedingToolCallIds.clear();
    }

    if (msg.role === 'tool' && msg.tool_call_id) {
      if (!precedingToolCallIds.has(msg.tool_call_id)) {
        console.log(`[sessions] Dropping orphaned tool result: ${msg.tool_call_id}`);
        continue;
      }
      precedingToolCallIds.delete(msg.tool_call_id);
    }

    if (typeof msg.content !== 'string' && msg.content.some(b => b.type === 'tool_result')) {
      const hasOrphan = msg.content.some(b => b.type === 'tool_result' && b.tool_use_id && !precedingToolCallIds.has(b.tool_use_id));
      if (hasOrphan) {
        const validBlocks = msg.content.filter(b => {
          if (b.type === 'tool_result' && b.tool_use_id && !precedingToolCallIds.has(b.tool_use_id)) {
            console.log(`[sessions] Dropping orphaned tool_result block: ${b.tool_use_id}`);
            return false;
          }
          return true;
        });
        if (validBlocks.length === 0) continue;
        msg.content = validBlocks;
      }
    }

    if (typeof msg.content !== 'string') {
      for (const block of msg.content) {
        if (block.type === 'tool_result' && block.tool_use_id) precedingToolCallIds.delete(block.tool_use_id);
      }
    }
    filtered.push(msg);
    if (msg.role === 'user' || msg.role === 'system') precedingToolCallIds.clear();
  }
  return filtered;
}

function toolCallIds(message: Message): string[] {
  const ids = (message.tool_calls ?? []).map(call => call.id);
  if (typeof message.content !== 'string') {
    for (const block of message.content) {
      if (block.type === 'tool_use' && block.id) ids.push(block.id);
    }
  }
  return ids;
}

function toolResultIds(message: Message): string[] {
  const ids = message.role === 'tool' && message.tool_call_id ? [message.tool_call_id] : [];
  if (typeof message.content !== 'string') {
    for (const block of message.content) {
      if (block.type === 'tool_result' && block.tool_use_id) ids.push(block.tool_use_id);
    }
  }
  return ids;
}

function safeArchiveBoundary(messages: Message[], requestedBoundary: number): number {
  let boundary = Math.max(0, Math.min(messages.length, requestedBoundary));
  for (let index = 0; index < boundary; index++) {
    const callIds = toolCallIds(messages[index]);
    if (callIds.length === 0) continue;
    const callIdSet = new Set(callIds);
    const hasResultAfterBoundary = messages.slice(boundary).some(message =>
      toolResultIds(message).some(id => callIdSet.has(id)),
    );
    if (hasResultAfterBoundary) boundary = index;
  }
  return boundary;
}

export class SessionManager {
  private dir: string;
  private ttl: number;
  private sessionSummaryCache: Map<string, SessionSummary> | null = null;

  constructor(baseDir?: string, ttl?: number, legacyDirs: string[] = [], legacyWorkspace?: string) {
    this.dir = path.resolve(baseDir ?? path.join(os.homedir(), DEFAULT_DIR));
    this.ttl = ttl ?? DEFAULT_TTL;
    for (const legacyDir of new Set(legacyDirs.map(directory => path.resolve(directory)))) {
      this.migrateLegacyDirectory(legacyDir);
    }
    fs.mkdirSync(this.dir, { recursive: true });
    if (legacyWorkspace) this.migrateLegacyProjectSessions(legacyWorkspace);
  }

  get directory(): string {
    return this.dir;
  }

  private legacyConflictPath(name: string): string {
    const archiveDirectory = path.join(this.dir, 'archive');
    fs.mkdirSync(archiveDirectory, { recursive: true });
    return path.join(archiveDirectory, `legacy-${Date.now()}-${randomUUID()}-${path.basename(name)}`);
  }

  private migrateLegacyDirectory(source: string, target = this.dir): void {
    const resolvedSource = path.resolve(source);
    const resolvedTarget = path.resolve(target);
    if (resolvedSource === resolvedTarget || !fs.existsSync(resolvedSource)) return;
    fs.mkdirSync(path.dirname(resolvedTarget), { recursive: true });
    const moveContents = (from: string, to: string): void => {
      if (fs.existsSync(to)) {
        const existing = fs.lstatSync(to);
        if (!existing.isDirectory() || existing.isSymbolicLink()) {
          to = this.legacyConflictPath(to);
        }
      }
      fs.mkdirSync(to, { recursive: true });
      for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const sourcePath = path.join(from, entry.name);
        let targetPath = path.join(to, entry.name);
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          if (fs.existsSync(targetPath)) {
            const existing = fs.lstatSync(targetPath);
            if (!existing.isDirectory() || existing.isSymbolicLink()) {
              targetPath = this.legacyConflictPath(targetPath);
            }
          }
          moveContents(sourcePath, targetPath);
          continue;
        }
        if (fs.existsSync(targetPath)) {
          targetPath = this.legacyConflictPath(targetPath);
        }
        try {
          fs.renameSync(sourcePath, targetPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
          if (entry.isSymbolicLink()) {
            throw new Error(`Cannot migrate symbolic link ${sourcePath} across filesystems.`, { cause: error });
          }
          fs.copyFileSync(sourcePath, targetPath);
          fs.unlinkSync(sourcePath);
        }
      }
      fs.rmdirSync(from);
    };

    console.log(`[sessions] Migrating session data from ${resolvedSource} to ${resolvedTarget}`);
    moveContents(resolvedSource, resolvedTarget);
  }

  private migrateLegacyProjectSessions(workspace: string): void {
    const projectsDirectory = path.join(path.resolve(workspace), '.agents', 'projects');
    let projects: fs.Dirent[];
    try {
      projects = fs.readdirSync(projectsDirectory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }

    for (const project of projects) {
      if (!project.isDirectory() || !/^[a-f0-9-]{36}$/i.test(project.name)) continue;
      const projectDirectory = path.join(projectsDirectory, project.name);
      this.migrateLegacyDirectory(
        path.join(projectDirectory, '.session'),
        path.join(this.dir, 'projects', project.name),
      );

      const agentsDirectory = path.join(projectDirectory, 'agents');
      let agents: fs.Dirent[];
      try {
        agents = fs.readdirSync(agentsDirectory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      for (const agent of agents) {
        if (!agent.isDirectory() || !/^[a-f0-9-]{36}$/i.test(agent.name)) continue;
        this.migrateLegacyDirectory(
          path.join(agentsDirectory, agent.name, '.session'),
          path.join(this.dir, 'projects', project.name, 'agents', agent.name),
        );
      }
    }
  }

  private filePath(id: string): string {
    const safe = id.replace(/[^a-zA-Z0-9_\-:.]/g, '_');
    const fileSafe = process.platform === 'win32' ? safe.replace(/:/g, '~3A') : safe;
    const scopedAgent = /^agent-([a-f0-9-]{36})-([a-f0-9-]{36})-/i.exec(id);
    if (scopedAgent) {
      return path.join(this.dir, 'projects', scopedAgent[1], 'agents', scopedAgent[2], `${fileSafe}.json`);
    }
    const scopedProject = /^project-([a-f0-9-]{36})-/i.exec(id);
    if (scopedProject) {
      return path.join(this.dir, 'projects', scopedProject[1], `${fileSafe}.json`);
    }
    return path.join(this.dir, `${fileSafe}.json`);
  }

  private sessionDirectories(): string[] {
    const directories = [this.dir];
    const projectsDirectory = path.join(this.dir, 'projects');
    let projects: fs.Dirent[];
    try {
      projects = fs.readdirSync(projectsDirectory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return directories;
      throw error;
    }
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const projectDirectory = path.join(projectsDirectory, project.name);
      directories.push(projectDirectory);
      const agentsDirectory = path.join(projectDirectory, 'agents');
      let agents: fs.Dirent[];
      try {
        agents = fs.readdirSync(agentsDirectory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      for (const agent of agents) {
        if (agent.isDirectory()) directories.push(path.join(agentsDirectory, agent.name));
      }
    }
    return directories;
  }

  private routesFilePath(): string {
    return path.join(this.dir, 'routes.json');
  }

  loadRoutes(): SessionRoute[] {
    let data: unknown;
    try {
      data = JSON.parse(fs.readFileSync(this.routesFilePath(), 'utf-8')) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error(`Failed to load session routes: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    if (!Array.isArray(data)) throw new Error('Failed to load session routes: expected a JSON array');
    return data.filter((route): route is SessionRoute =>
      !!route
      && typeof route === 'object'
      && typeof route.channelType === 'string'
      && typeof route.chatId === 'string'
      && typeof route.sessionId === 'string'
      && typeof route.lastActive === 'number'
      && (route.adapterId === undefined || typeof route.adapterId === 'string'),
    );
  }

  saveRoute(route: SessionRoute): void {
    const routes = this.loadRoutes();
    const adapterId = route.adapterId ?? route.channelType;
    const existingIndex = routes.findIndex(existing =>
      (existing.adapterId ?? existing.channelType) === adapterId
      && existing.chatId === route.chatId,
    );
    if (existingIndex >= 0) routes[existingIndex] = route;
    else routes.push(route);

    const destination = this.routesFilePath();
    atomicWriteFile(destination, JSON.stringify(routes, null, 2), 'session routes');
  }

  private defaultMetadata(): SessionMetadata {
    return { messageCount: 0, tokenUsage: { input: 0, output: 0 }, toolsUsed: {}, depth: 0 };
  }

  create(id: string, opts?: { label?: string; provider?: string; model?: string; parentSessionId?: string; depth?: number; sessionKind?: 'conversation' | 'subagent'; hiddenFromList?: boolean; projectId?: string; agentId?: string }): Session {
    const session: Session = {
      id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      metadata: {
        ...this.defaultMetadata(),
        label: opts?.label,
        provider: opts?.provider,
        model: opts?.model,
        parentSessionId: opts?.parentSessionId,
        projectId: opts?.projectId,
        agentId: opts?.agentId,
        sessionKind: opts?.sessionKind ?? (opts?.parentSessionId ? 'subagent' : (id.startsWith('web-') ? 'conversation' : undefined)),
        hiddenFromList: opts?.hiddenFromList,
        depth: opts?.depth ?? 0,
      },
    };
    this.save(session);
    return session;
  }

  load(id: string): Session | null {
    let data: Session;
    try {
      data = JSON.parse(fs.readFileSync(this.filePath(id), 'utf-8')) as Session;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error(`Failed to load session ${id}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    // Backfill metadata for old sessions
    if (!data.metadata || typeof data.metadata !== 'object' || !('messageCount' in data.metadata)) {
      data.metadata = { ...this.defaultMetadata(), ...(data.metadata as Record<string, unknown> ?? {}) } as SessionMetadata;
    }
    // Sanitize tool pairs — persist cleanup so stale results are not dropped on every load.
    const originalMessages = JSON.stringify(data.messages);
    const originalLabel = data.metadata.label;
    data.messages = sanitizeToolPairs(stripBlinkControlMessages(data.messages));
    const title = data.metadata.hiddenFromList ? undefined : deriveConversationTitle(data.messages);
    if (title) data.metadata.label = title;
    if (JSON.stringify(data.messages) !== originalMessages || (title && originalLabel !== title)) this.save(data);
    return data;
  }

  save(session: Session): void {
    session.updatedAt = Date.now();
    session.metadata.messageCount = session.messages.length;
    const title = session.metadata.hiddenFromList ? undefined : deriveConversationTitle(session.messages);
    if (title) session.metadata.label = title;
    const destination = this.filePath(session.id);
    atomicWriteFile(destination, JSON.stringify(session, null, 2), `session ${session.id}`);
    this.updateCachedSummary(session, title);
  }

  private summarizeSession(session: Session, title?: string): SessionSummary | undefined {
    const metadata = session.metadata;
    if (metadata?.hiddenFromList || session.id.startsWith('heartbeat-')) return undefined;
    return {
      id: session.id,
      label: title ?? deriveConversationTitle(session.messages) ?? metadata?.label,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: session.messages.length,
      provider: metadata?.provider,
      model: metadata?.model,
      parentSessionId: metadata?.parentSessionId,
      sessionKind: metadata?.sessionKind ?? (metadata?.parentSessionId ? 'subagent' : undefined),
      projectId: metadata?.projectId,
      agentId: metadata?.agentId,
    };
  }

  private updateCachedSummary(session: Session, title?: string): void {
    if (!this.sessionSummaryCache) return;
    const summary = this.summarizeSession(session, title);
    if (summary) this.sessionSummaryCache.set(session.id, summary);
    else this.sessionSummaryCache.delete(session.id);
  }

  delete(id: string): boolean {
    if (!id.trim()) throw new TypeError('A session ID is required for deletion.');

    const activeFile = this.filePath(id);
    const archiveDirectory = path.join(path.dirname(activeFile), 'archive');
    const routeFile = this.routesFilePath();
    const routes = this.loadRoutes();
    const remainingRoutes = routes.filter(route => route.sessionId !== id);
    const routeChanged = remainingRoutes.length !== routes.length;
    let removed = false;

    removed = unlinkAndVerify(activeFile, `session ${id}`) || removed;

    let archiveFiles: string[] = [];
    try {
      archiveFiles = fs.readdirSync(archiveDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new SessionPersistenceError(
          `Failed to inspect archived data for session ${id} at ${archiveDirectory}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }

    const archiveIds = new Set([
      path.basename(activeFile, '.json'),
      id.replace(/[^a-zA-Z0-9_\-:.]/g, '_'),
    ]);
    for (const file of archiveFiles) {
      if (!file.endsWith('.json')) continue;
      const base = file.slice(0, -'.json'.length);
      const isArchivedSession = [...archiveIds].some(archiveId => base === archiveId);
      const isArchivedMessages = [...archiveIds].some(archiveId => {
        const prefix = `${archiveId}-`;
        return base.startsWith(prefix) && /^\d+$/.test(base.slice(prefix.length));
      });
      if (!isArchivedSession && !isArchivedMessages) continue;
      removed = unlinkAndVerify(path.join(archiveDirectory, file), `archived session ${id}`) || removed;
    }

    if (routeChanged) {
      atomicWriteFile(routeFile, JSON.stringify(remainingRoutes, null, 2), 'session routes');
      const persistedRoutes = this.loadRoutes();
      if (persistedRoutes.some(route => route.sessionId === id)) {
        throw new SessionPersistenceError(`Failed to verify route cleanup for session ${id}.`);
      }
      removed = true;
    }

    this.sessionSummaryCache?.delete(id);
    return removed;
  }

  archiveSession(id: string): boolean {
    const source = this.filePath(id);
    if (!fs.existsSync(source)) return false;
    const destination = path.join(path.dirname(source), 'archive', path.basename(source));
    if (fs.existsSync(destination)) {
      throw new Error(`Cannot archive session ${id}: an archived session with the same id already exists.`);
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(source, destination);
    this.sessionSummaryCache?.delete(id);
    return true;
  }

  restoreProjectSessions(projectId: string): number {
    if (!/^[a-f0-9-]{36}$/i.test(projectId)) throw new Error('Project ID is invalid.');
    const projectDirectory = path.join(this.dir, 'projects', projectId);
    const sessionRoots = [projectDirectory];
    const agentsDirectory = path.join(projectDirectory, 'agents');
    try {
      for (const entry of fs.readdirSync(agentsDirectory, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.isSymbolicLink()) sessionRoots.push(path.join(agentsDirectory, entry.name));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const sessions: Array<{ id: string; source: string; destination: string }> = [];
    for (const root of sessionRoots) {
      const archiveDirectory = path.join(root, 'archive');
      let files: string[];
      try {
        files = fs.readdirSync(archiveDirectory).filter(file => file.endsWith('.json'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      for (const file of files) {
        const source = path.join(archiveDirectory, file);
        const parsed: unknown = JSON.parse(fs.readFileSync(source, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || !('id' in parsed) || typeof parsed.id !== 'string'
          || !('metadata' in parsed) || !parsed.metadata || typeof parsed.metadata !== 'object'
          || !('projectId' in parsed.metadata) || parsed.metadata.projectId !== projectId) continue;
        const destination = this.filePath(parsed.id);
        if (path.resolve(source) !== path.resolve(path.join(path.dirname(destination), 'archive', path.basename(destination)))) continue;
        if (fs.existsSync(destination)) throw new Error(`Cannot restore project session ${parsed.id}: an active session with the same id already exists.`);
        sessions.push({ id: parsed.id, source, destination });
      }
    }
    for (const session of sessions) {
      fs.mkdirSync(path.dirname(session.destination), { recursive: true });
      fs.renameSync(session.source, session.destination);
    }
    if (sessions.length > 0) this.sessionSummaryCache = null;
    return sessions.length;
  }

  list(): SessionSummary[] {
    if (this.sessionSummaryCache) {
      return [...this.sessionSummaryCache.values()]
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .map(summary => ({ ...summary }));
    }

    try {
      const summaries = new Map<string, SessionSummary>();
      for (const directory of this.sessionDirectories()) {
        let files: string[];
        try {
          files = fs.readdirSync(directory).filter(file => file.endsWith('.json'));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        for (const file of files) {
          try {
            const parsed = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf-8')) as Session;
            const s = this.load(parsed.id) ?? parsed;
            const summary = this.summarizeSession(s);
            if (summary) summaries.set(s.id, summary);
          } catch { /* skip */ }
        }
      }
      this.sessionSummaryCache = summaries;
      return [...summaries.values()]
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .map(summary => ({ ...summary }));
    } catch {
      return [];
    }
  }

  /** Update token usage */
  trackUsage(session: Session, input: number, output: number): void {
    session.metadata.tokenUsage.input += input;
    session.metadata.tokenUsage.output += output;
  }

  /** Track tool call */
  trackToolCall(session: Session, toolName: string): void {
    session.metadata.toolsUsed[toolName] = (session.metadata.toolsUsed[toolName] ?? 0) + 1;
  }

  /** Clean up stale sessions older than TTL */
  cleanup(): number {
    const now = Date.now();
    let cleaned = 0;
    for (const directory of this.sessionDirectories()) {
      let files: string[];
      try {
        files = fs.readdirSync(directory).filter(file => file.endsWith('.json'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      for (const file of files) {
        const source = path.join(directory, file);
        let serialized: string;
        try {
          serialized = fs.readFileSync(source, 'utf-8');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw new Error(`Failed to inspect session file ${source}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }
        let session: Session;
        try {
          session = JSON.parse(serialized) as Session;
        } catch (error) {
          console.warn(`[sessions] Skipping invalid session file ${source}: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        if (typeof session.id !== 'string' || typeof session.updatedAt !== 'number' || now - session.updatedAt <= this.ttl) continue;
        if (this.delete(session.id)) cleaned++;
      }
    }
    return cleaned;
  }

  /** Rename / label a session */
  setLabel(id: string, label: string): boolean {
    const session = this.load(id);
    if (!session) return false;
    session.metadata.label = label;
    this.save(session);
    return true;
  }

  // ── Session Archival ─────────────────────────────────────────────────────

  /**
   * Archive a session: move old messages to an archive file, keep only
   * the system prompt + last N messages in the active session.
   * Returns number of messages archived.
   */
  archive(id: string, keepMessages = 20): number {
    const session = this.load(id);
    if (!session || session.messages.length <= keepMessages) return 0;

    // Separate system prompt from conversation
    const systemMsgs = session.messages.filter(m => m.role === 'system');
    const convMsgs = session.messages.filter(m => m.role !== 'system');

    if (convMsgs.length <= keepMessages) return 0;

    // Archive the old messages
    const requestedBoundary = convMsgs.length - keepMessages;
    const boundary = safeArchiveBoundary(convMsgs, requestedBoundary);
    const toArchive = convMsgs.slice(0, boundary);
    const toKeep = convMsgs.slice(boundary);

    const archiveDirectory = path.join(path.dirname(this.filePath(id)), 'archive');
    fs.mkdirSync(archiveDirectory, { recursive: true });
    const archiveFile = path.join(archiveDirectory, `${id.replace(/[^a-zA-Z0-9_\-:.]/g, '_')}-${Date.now()}.json`);
    const archiveData = {
      sessionId: id,
      archivedAt: Date.now(),
      messageCount: toArchive.length,
      tokenUsage: { ...session.metadata.tokenUsage },
      messages: toArchive,
    };
    fs.writeFileSync(archiveFile, JSON.stringify(archiveData));

    // Update active session
    session.messages = [...systemMsgs, ...toKeep];
    this.save(session);

    console.log(`[sessions] Archived ${toArchive.length} messages from ${id} → ${path.basename(archiveFile)}`);
    return toArchive.length;
  }

  /**
   * Auto-archive sessions that exceed a size threshold.
   * Call periodically (e.g., after each agent turn).
   */
  autoArchive(maxSizeBytes = 200 * 1024, keepMessages = 30): number {
    let totalArchived = 0;
    try {
      for (const f of fs.readdirSync(this.dir).filter(f => f.endsWith('.json'))) {
        const fp = path.join(this.dir, f);
        try {
          const stat = fs.statSync(fp);
          if (stat.size > maxSizeBytes) {
            const id = f.replace('.json', '').replace(/_/g, '/');
            // Load to get actual ID
            const session = JSON.parse(fs.readFileSync(fp, 'utf-8')) as Session;
            totalArchived += this.archive(session.id, keepMessages);
          }
        } catch { /* skip */ }
      }
    } catch { /* dir doesn't exist */ }
    return totalArchived;
  }

}
