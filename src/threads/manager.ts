import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type ThreadScope = 'project' | 'selected' | 'open' | 'external';
export type ThreadActor = { type: 'user' | 'agent' | 'external'; id: string; projectId?: string; label?: string };
export type ThreadPostKind = 'message' | 'user_help';

export interface ThreadPost {
  id: string;
  author: Pick<ThreadActor, 'type' | 'id' | 'label'>;
  body: string;
  mentions: string[];
  createdAt: number;
  kind?: ThreadPostKind;
  readBy?: string[];
  reactions?: Array<{ emoji: string; actors: string[] }>;
}

export interface AgentThread {
  id: string;
  title: string;
  scope: ThreadScope;
  projectId?: string;
  participants: string[];
  externalContactIds: string[];
  createdBy: Pick<ThreadActor, 'type' | 'id' | 'label'>;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
  posts: ThreadPost[];
}

export interface ThreadContact {
  id: string;
  label: string;
  tokenHash: string;
  createdAt: number;
  active: boolean;
  postTimes: number[];
}

export interface ThreadNotification {
  id: string;
  threadId: string;
  postId: string;
  contactLabel: string;
  summary: string;
  createdAt: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
  attempts: number;
  lastError?: string;
}

export interface CreateThreadInput {
  title: string;
  scope: ThreadScope;
  projectId?: string;
  participants?: string[];
  externalContactIds?: string[];
}

export interface ThreadUserHelpRequest {
  id: string;
  threadId: string;
  postId: string;
  title: string;
  body: string;
  createdAt: number;
}

interface ThreadData {
  version: 1;
  threads: AgentThread[];
  contacts: ThreadContact[];
  notifications: ThreadNotification[];
}

const MAX_POST_LENGTH = 12_000;
const MAX_PARTICIPANTS = 50;
const MAX_USER_HELP_REQUESTS_PER_HOUR = 6;
const MAX_EXTERNAL_CONTACT_POSTS_PER_HOUR = 60;
const EXTERNAL_CONTACT_RATE_WINDOW_MS = 60 * 60 * 1000;

export function sanitizeThreadText(value: string, maxLength = MAX_POST_LENGTH): string {
  const clean = value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim();
  if (!clean) throw new Error('Thread text cannot be empty.');
  if (clean.length > maxLength) throw new Error(`Thread text must be ${maxLength.toLocaleString()} characters or fewer.`);
  return clean;
}

function safeLabel(value: string, field: string, maxLength = 100): string {
  const result = sanitizeThreadText(value, maxLength).replace(/\s+/g, ' ');
  if (/[\u0000-\u001f\u007f]/.test(result)) throw new Error(`${field} contains unsupported control characters.`);
  return result;
}

function readData(filePath: string): ThreadData {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || (parsed as ThreadData).version !== 1
      || !Array.isArray((parsed as ThreadData).threads)
      || !Array.isArray((parsed as ThreadData).contacts)
      || !Array.isArray((parsed as ThreadData).notifications)) {
      throw new Error('Thread storage is malformed or uses an unsupported version.');
    }
    return parsed as ThreadData;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, threads: [], contacts: [], notifications: [] };
    }
    throw error;
  }
}

export class ThreadManager {
  private readonly root: string;
  private readonly filePath: string;
  private notificationHandler: ((notification: ThreadNotification) => Promise<void>) | null = null;
  private notificationTimer: NodeJS.Timeout | null = null;
  private processingNotification = false;

  constructor(
    workspaceRoot: string,
    private readonly isKnownAgent: (agentId: string) => boolean = () => true,
    private readonly isKnownProject: (projectId: string) => boolean = () => true,
    private readonly isAgentInProject: (agentId: string, projectId: string) => boolean = () => true,
  ) {
    this.root = path.join(path.resolve(workspaceRoot), '.threads');
    this.filePath = path.join(this.root, 'threads.json');
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  listThreads(actor: ThreadActor, includeArchived = false): AgentThread[] {
    return readData(this.filePath).threads
      .filter(thread => (includeArchived || !thread.archivedAt) && this.canRead(thread, actor))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(thread => structuredClone(thread));
  }

  getThread(id: string, actor: ThreadActor): AgentThread | undefined {
    const thread = readData(this.filePath).threads.find(item => item.id === id);
    if (!thread || thread.archivedAt || !this.canRead(thread, actor)) return undefined;
    return structuredClone(thread);
  }

  createThread(input: CreateThreadInput, actor: ThreadActor): AgentThread {
    const title = safeLabel(input.title, 'Thread title', 120);
    const scope = input.scope;
    if (!['project', 'selected', 'open', 'external'].includes(scope)) throw new Error('Choose a valid thread scope.');
    const projectId = input.projectId?.trim() || undefined;
    if (scope === 'project' && (!projectId || !this.isKnownProject(projectId))) {
      throw new Error('Project-scoped threads require an existing project.');
    }
    if (scope === 'project' && actor.type === 'agent' && actor.id !== 'main'
      && actor.projectId !== projectId && !this.agentBelongsToProject(actor.id, projectId!)) {
      throw new Error('Agents can only create project threads for their assigned project.');
    }
    if (scope !== 'project' && projectId) throw new Error('Only project-scoped threads may specify a project.');
    const participants = this.validateParticipants(input.participants ?? [], actor.id);
    if (scope === 'external' && actor.type !== 'user') {
      throw new Error('External-access threads can only be created by the user.');
    }
    const externalContactIds = [...new Set(input.externalContactIds ?? [])];
    const data = readData(this.filePath);
    for (const contactId of externalContactIds) {
      if (!data.contacts.some(contact => contact.id === contactId && contact.active)) {
        throw new Error(`External contact ${contactId} is unavailable.`);
      }
    }
    if (scope === 'external' && externalContactIds.length === 0) {
      throw new Error('Choose at least one active external contact for an external-access thread.');
    }
    if (scope === 'selected' && participants.length === 0) {
      throw new Error('Selected-agent threads require at least one invited agent.');
    }
    if (scope === 'project' && participants.some(id => !this.agentBelongsToProject(id, projectId!))) {
      throw new Error('Project-scoped threads can only invite agents assigned to that project.');
    }
    const timestamp = Date.now();
    const thread: AgentThread = {
      id: crypto.randomUUID(),
      title,
      scope,
      ...(projectId ? { projectId } : {}),
      participants: [...new Set([...participants, ...(actor.type === 'agent' ? [actor.id] : [])])],
      externalContactIds,
      createdBy: this.publicActor(actor),
      createdAt: timestamp,
      updatedAt: timestamp,
      posts: [],
    };
    data.threads.push(thread);
    this.write(data);
    return structuredClone(thread);
  }

  postMessage(id: string, actor: ThreadActor, bodyValue: string, mentionedAgentIds: string[] = [], kind: ThreadPostKind = 'message'): AgentThread {
    const body = sanitizeThreadText(bodyValue);
    const data = readData(this.filePath);
    const thread = data.threads.find(item => item.id === id && !item.archivedAt);
    if (!thread || !this.canRead(thread, actor)) throw new Error('Thread is unavailable or you are not an invited participant.');
    if (actor.type === 'external' && !thread.externalContactIds.includes(actor.id)) {
      throw new Error('This contact is not permitted to post in the thread.');
    }
    const mentions = this.validateParticipants(mentionedAgentIds, actor.id);
    if (thread.scope === 'project' && mentions.some(agentId => !this.agentBelongsToProject(agentId, thread.projectId!))) {
      throw new Error('Project-scoped threads cannot mention agents from another project.');
    }
    const post: ThreadPost = {
      id: crypto.randomUUID(),
      author: this.publicActor(actor),
      body,
      mentions,
      createdAt: Date.now(),
      kind,
      readBy: [this.readerKey(actor)],
      reactions: [],
    };
    thread.posts.push(post);
    thread.participants = [...new Set([...thread.participants, ...mentions])];
    thread.updatedAt = post.createdAt;
    if (actor.type === 'external') {
      this.enqueueNotification(data, thread, post, actor);
    }
    this.write(data);
    return structuredClone(thread);
  }

  requestUserHelp(actor: ThreadActor, titleValue: string, bodyValue: string): AgentThread {
    if (actor.type !== 'agent') throw new Error('Only agents can request user assistance.');
    const title = safeLabel(titleValue, 'Help request title', 120);
    const recentCutoff = Date.now() - EXTERNAL_CONTACT_RATE_WINDOW_MS;
    const recentRequests = readData(this.filePath).threads
      .flatMap(thread => thread.posts)
      .filter(post => post.kind === 'user_help' && post.author.type === 'agent' && post.author.id === actor.id && post.createdAt > recentCutoff);
    if (recentRequests.length >= MAX_USER_HELP_REQUESTS_PER_HOUR) {
      throw new Error('This agent reached the user-assistance request limit. Wait before asking again.');
    }
    const scope: ThreadScope = actor.projectId ? 'project' : actor.id === 'main' ? 'open' : 'selected';
    const thread = this.createThread({
      title,
      scope,
      ...(actor.projectId ? { projectId: actor.projectId } : {}),
      participants: ['main', actor.id],
    }, actor);
    return this.postMessage(thread.id, actor, bodyValue, [], 'user_help');
  }

  listUnreadUserHelpRequests(): ThreadUserHelpRequest[] {
    const requests: ThreadUserHelpRequest[] = [];
    for (const thread of readData(this.filePath).threads) {
      if (thread.archivedAt) continue;
      for (const post of thread.posts) {
        if (post.kind !== 'user_help' || (post.readBy ?? []).includes('user:user')) continue;
        requests.push({
          id: `${thread.id}:${post.id}`,
          threadId: thread.id,
          postId: post.id,
          title: thread.title,
          body: post.body,
          createdAt: post.createdAt,
        });
      }
    }
    return requests.sort((left, right) => right.createdAt - left.createdAt);
  }

  markThreadRead(id: string, actor: ThreadActor, postId?: string): AgentThread {
    const data = readData(this.filePath);
    const thread = data.threads.find(item => item.id === id && !item.archivedAt);
    if (!thread || !this.canRead(thread, actor)) throw new Error('Thread is unavailable or you are not an invited participant.');
    const posts = postId ? thread.posts.filter(post => post.id === postId) : thread.posts;
    if (postId && posts.length === 0) throw new Error('Thread post was not found.');
    const readerKey = this.readerKey(actor);
    for (const post of posts) post.readBy = [...new Set([...(post.readBy ?? []), readerKey])];
    this.write(data);
    return structuredClone(thread);
  }

  reactToPost(id: string, postId: string, actor: ThreadActor, emojiValue: string): AgentThread {
    const emoji = emojiValue.trim();
    if (!emoji || Array.from(emoji).length > 8 || /\s|[\u0000-\u001f\u007f]/u.test(emoji)
      || !/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}]/u.test(emoji)) {
      throw new Error('Reaction must be a single emoji.');
    }
    const data = readData(this.filePath);
    const thread = data.threads.find(item => item.id === id && !item.archivedAt);
    if (!thread || !this.canRead(thread, actor)) throw new Error('Thread is unavailable or you are not an invited participant.');
    const post = thread.posts.find(item => item.id === postId);
    if (!post) throw new Error('Thread post was not found.');
    const reactions = post.reactions ?? [];
    let reaction = reactions.find(item => item.emoji === emoji);
    if (!reaction) {
      if (reactions.length >= 16) throw new Error('This post already has the maximum number of distinct reactions.');
      reaction = { emoji, actors: [] };
      reactions.push(reaction);
    }
    const actorKey = this.readerKey(actor);
    reaction.actors = reaction.actors.includes(actorKey)
      ? reaction.actors.filter(item => item !== actorKey)
      : [...reaction.actors, actorKey];
    post.reactions = reactions.filter(item => item.actors.length > 0);
    this.write(data);
    return structuredClone(thread);
  }

  archiveThread(id: string, actor: ThreadActor): boolean {
    if (actor.type !== 'user') throw new Error('Only the user can archive a thread.');
    const data = readData(this.filePath);
    const thread = data.threads.find(item => item.id === id && !item.archivedAt);
    if (!thread) return false;
    thread.archivedAt = Date.now();
    thread.updatedAt = thread.archivedAt;
    this.write(data);
    return true;
  }

  createContact(labelValue: string): { id: string; label: string; createdAt: number; token: string } {
    const label = safeLabel(labelValue, 'Contact name', 80);
    const token = crypto.randomBytes(32).toString('base64url');
    const contact: ThreadContact = {
      id: crypto.randomUUID(),
      label,
      tokenHash: this.hashToken(token),
      createdAt: Date.now(),
      active: true,
      postTimes: [],
    };
    const data = readData(this.filePath);
    data.contacts.push(contact);
    this.write(data);
    return { id: contact.id, label, createdAt: contact.createdAt, token };
  }

  listContacts(): Array<Omit<ThreadContact, 'tokenHash' | 'postTimes'>> {
    return readData(this.filePath).contacts.filter(contact => contact.active)
      .map(({ tokenHash: _hash, postTimes: _times, ...contact }) => contact);
  }

  deleteContact(id: string): boolean {
    const data = readData(this.filePath);
    const contact = data.contacts.find(item => item.id === id && item.active);
    if (!contact) return false;
    contact.active = false;
    for (const thread of data.threads) {
      thread.externalContactIds = thread.externalContactIds.filter(contactId => contactId !== id);
    }
    this.write(data);
    return true;
  }

  authenticateContact(token: string): { id: string; label: string } | undefined {
    if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return undefined;
    const hash = this.hashToken(token);
    const contact = readData(this.filePath).contacts.find(item => item.active
      && /^[a-f\d]{64}$/i.test(item.tokenHash)
      && crypto.timingSafeEqual(Buffer.from(item.tokenHash, 'hex'), Buffer.from(hash, 'hex')));
    return contact ? { id: contact.id, label: contact.label } : undefined;
  }

  externalCreateThread(contact: { id: string; label: string }, title: string, body: string): AgentThread {
    const cleanBody = sanitizeThreadText(body);
    this.recordExternalPost(contact.id);
    const thread = this.createThread({
      title,
      scope: 'external',
      externalContactIds: [contact.id],
      participants: ['main'],
    }, { type: 'user', id: 'user' });
    return this.postMessage(thread.id, { type: 'external', ...contact }, cleanBody);
  }

  externalPostMessage(contact: { id: string; label: string }, threadId: string, body: string): AgentThread {
    const cleanBody = sanitizeThreadText(body);
    const data = readData(this.filePath);
    const savedContact = data.contacts.find(item => item.id === contact.id && item.active);
    if (!savedContact) throw new Error('External contact is unavailable.');
    const cutoff = Date.now() - EXTERNAL_CONTACT_RATE_WINDOW_MS;
    savedContact.postTimes = savedContact.postTimes.filter(time => time > cutoff);
    if (savedContact.postTimes.length >= MAX_EXTERNAL_CONTACT_POSTS_PER_HOUR) {
      throw new Error('External contact rate limit exceeded. Try again later.');
    }
    savedContact.postTimes.push(Date.now());
    const thread = data.threads.find(item => item.id === threadId && !item.archivedAt
      && item.scope === 'external' && item.externalContactIds.includes(contact.id));
    if (!thread) throw new Error('Thread is unavailable to this external contact.');
    const post: ThreadPost = {
      id: crypto.randomUUID(),
      author: this.publicActor({ type: 'external', ...contact }),
      body: cleanBody,
      mentions: [],
      createdAt: Date.now(),
      kind: 'message',
      readBy: [this.readerKey({ type: 'external', ...contact })],
      reactions: [],
    };
    thread.posts.push(post);
    thread.updatedAt = post.createdAt;
    this.enqueueNotification(data, thread, post, { type: 'external', ...contact });
    this.write(data);
    return structuredClone(thread);
  }

  listExternalThreads(contactId: string): AgentThread[] {
    return readData(this.filePath).threads
      .filter(thread => !thread.archivedAt && thread.scope === 'external' && thread.externalContactIds.includes(contactId))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(thread => structuredClone(thread));
  }

  getExternalThread(contactId: string, threadId: string): AgentThread | undefined {
    const thread = readData(this.filePath).threads.find(item => item.id === threadId
      && !item.archivedAt && item.scope === 'external' && item.externalContactIds.includes(contactId));
    return thread ? structuredClone(thread) : undefined;
  }

  startNotifications(handler: (notification: ThreadNotification) => Promise<void>): void {
    this.notificationHandler = handler;
    const data = readData(this.filePath);
    let recovered = false;
    for (const notification of data.notifications) {
      if (notification.status === 'running') {
        notification.status = 'pending';
        recovered = true;
      }
    }
    if (recovered) this.write(data);
    this.notificationTimer ??= setInterval(() => void this.processNotifications(), 1_000);
    void this.processNotifications();
  }

  stopNotifications(): void {
    if (this.notificationTimer) clearInterval(this.notificationTimer);
    this.notificationTimer = null;
    this.notificationHandler = null;
  }

  retryNotification(id: string): ThreadNotification {
    const data = readData(this.filePath);
    const notification = data.notifications.find(item => item.id === id);
    if (!notification) throw new Error(`Thread notification ${id} was not found.`);
    if (notification.status !== 'failed') throw new Error('Only failed thread notifications can be retried.');
    notification.status = 'pending';
    notification.lastError = undefined;
    this.write(data);
    void this.processNotifications();
    return structuredClone(notification);
  }

  private async processNotifications(): Promise<void> {
    if (this.processingNotification || !this.notificationHandler) return;
    const data = readData(this.filePath);
    const notification = data.notifications.find(item => item.status === 'pending');
    if (!notification) return;
    this.processingNotification = true;
    notification.status = 'running';
    notification.attempts++;
    this.write(data);
    try {
      await this.notificationHandler(structuredClone(notification));
      const latest = readData(this.filePath);
      const completed = latest.notifications.find(item => item.id === notification.id);
      if (completed) {
        completed.status = 'completed';
        completed.lastError = undefined;
        this.write(latest);
      }
    } catch (error) {
      const latest = readData(this.filePath);
      const failed = latest.notifications.find(item => item.id === notification.id);
      if (failed) {
        failed.status = 'failed';
        failed.lastError = error instanceof Error ? error.message.slice(0, 500) : 'Unknown notification failure.';
        this.write(latest);
      }
      console.error(`[threads] Could not process notification ${notification.id}:`, error);
    } finally {
      this.processingNotification = false;
    }
  }

  private enqueueNotification(data: ThreadData, thread: AgentThread, post: ThreadPost, contact: ThreadActor): void {
    const summary = post.body.replace(/\s+/g, ' ').slice(0, 2_000);
    data.notifications.push({
      id: crypto.randomUUID(),
      threadId: thread.id,
      postId: post.id,
      contactLabel: contact.label ?? 'External contact',
      summary,
      createdAt: Date.now(),
      status: 'pending',
      attempts: 0,
    });
  }

  private validateParticipants(values: string[], actorId: string): string[] {
    if (!Array.isArray(values) || values.length > MAX_PARTICIPANTS
      || values.some(value => typeof value !== 'string' || !value.trim() || value.length > 100)) {
      throw new Error(`Choose no more than ${MAX_PARTICIPANTS} valid agent IDs.`);
    }
    const ids = [...new Set(values.map(value => value.trim()))];
    for (const id of ids) {
      if (id !== 'main' && id !== actorId && !this.isKnownAgent(id)) {
        throw new Error(`Agent ${id} is unavailable.`);
      }
    }
    return ids.filter(id => id !== actorId);
  }

  private agentBelongsToProject(agentId: string, projectId: string): boolean {
    return agentId === 'main' || this.isAgentInProject(agentId, projectId);
  }

  private canRead(thread: AgentThread, actor: ThreadActor): boolean {
    if (actor.type === 'user') return true;
    if (actor.type === 'external') return thread.externalContactIds.includes(actor.id);
    if (thread.scope === 'open') return true;
    if (thread.scope === 'external') return actor.id === 'main' || thread.participants.includes(actor.id);
    if (thread.scope === 'project' && actor.id !== 'main' && actor.projectId !== thread.projectId) return false;
    return thread.createdBy.id === actor.id || thread.participants.includes(actor.id);
  }

  private publicActor(actor: ThreadActor): Pick<ThreadActor, 'type' | 'id' | 'label'> {
    return { type: actor.type, id: actor.id, ...(actor.label ? { label: safeLabel(actor.label, 'Actor name', 80) } : {}) };
  }

  private readerKey(actor: ThreadActor): string {
    return `${actor.type}:${actor.id}`;
  }

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  private recordExternalPost(contactId: string): void {
    const data = readData(this.filePath);
    const contact = data.contacts.find(item => item.id === contactId && item.active);
    if (!contact) throw new Error('External contact is unavailable.');
    const cutoff = Date.now() - EXTERNAL_CONTACT_RATE_WINDOW_MS;
    contact.postTimes = contact.postTimes.filter(time => time > cutoff);
    if (contact.postTimes.length >= MAX_EXTERNAL_CONTACT_POSTS_PER_HOUR) {
      throw new Error('External contact rate limit exceeded. Try again later.');
    }
    contact.postTimes.push(Date.now());
    this.write(data);
  }

  private write(data: ThreadData): void {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, this.filePath);
    } catch (error) {
      try { fs.rmSync(temporary, { force: true }); } catch { /* Preserve the storage error. */ }
      throw error;
    }
  }
}
