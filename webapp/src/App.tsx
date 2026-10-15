import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent as ReactMouseEvent } from 'react';
import type { ReactNode, RefObject } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Activity, ArrowRight, ArrowUpRight, Bell, Bot, Check, ChevronDown, CircleAlert, CircleCheck, Clock3, Command, Compass, Copy, Cpu,
  Archive, Brain, Download, FileClock, Gauge, Globe, HardDrive, History, Info, LayoutDashboard, Leaf, LoaderCircle, Maximize2, Menu, MemoryStick, MessageSquare, Minimize2, Moon, Network,
  Biohazard, Plus, RefreshCw, Search, Send, Server, Settings2, ShieldCheck, Sparkles, Sun, TerminalSquare, Thermometer, Users, Wrench, X,
} from 'lucide-react';
import type { ChatMessage, GatewayConfig, GatewayStatus, HostResourceSnapshot, SessionSummary, ToolSummary, ViewId, WorkspaceAgent, WorkspaceRun } from './types';

declare const __SYMBIOTE_VERSION__: string;

const GamesView = lazy(() => import('./components/GamesView'));
const MemoryMap = lazy(() => import('./components/MemoryMap'));

const NAVIGATION: { id: ViewId; label: string; icon: typeof LayoutDashboard; group: string }[] = [
  { id: 'workspace', label: 'Workspace', icon: LayoutDashboard, group: 'Work' },
  { id: 'runs', label: 'Tasks', icon: Activity, group: 'Work' },
  { id: 'agents', label: 'Agents', icon: Users, group: 'Work' },
  { id: 'chat', label: 'Conversations', icon: MessageSquare, group: 'Work' },
  { id: 'browser', label: 'Browser', icon: Globe, group: 'Work' },
  { id: 'memory', label: 'Memory', icon: Brain, group: 'Work' },
  { id: 'sessions', label: 'Session history', icon: FileClock, group: 'Work' },
  { id: 'games', label: 'Zen', icon: Leaf, group: 'Play' },
  { id: 'operations', label: 'Operations', icon: Activity, group: 'Runtime' },
  { id: 'tools', label: 'Tool registry', icon: Wrench, group: 'Runtime' },
  { id: 'settings', label: 'Configuration', icon: Settings2, group: 'Runtime' },
];

type Theme = 'light' | 'dark';

function createClientId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

declare global {
  interface Window {
    symbioteDesktop?: {
      openMini(): Promise<void>;
      expand(): Promise<void>;
      closeMini(): Promise<void>;
      getOpacity(): Promise<number>;
      setOpacity(opacity: number): Promise<number>;
      requestLanAccess(): Promise<{ status: string }>;
    };
  }
}

function ResourceStatusStrip({ host }: { host?: HostResourceSnapshot }) {
  const warmestSensor = host?.temperature.sensors.reduce((warmest, sensor) =>
    !warmest || sensor.celsius > warmest.celsius ? sensor : warmest,
  undefined as HostResourceSnapshot['temperature']['sensors'][number] | undefined);
  const indicators = [
    { label: 'CPU', value: host?.cpuPercent, unit: '%', warning: 70, critical: 85 },
    { label: 'RAM', value: host?.memory.usedPercent, unit: '%', warning: 70, critical: 85 },
    { label: 'TEMP', value: warmestSensor?.celsius, unit: '°C', warning: 70, critical: 85 },
  ];
  return (
    <footer className="notification-health-strip" aria-label="Live computer resource status">
      {indicators.map(({ label, value, unit, warning, critical }) => {
        const level = value === undefined || value === null || !Number.isFinite(value)
          ? 'unknown'
          : value >= critical ? 'critical' : value >= warning ? 'warning' : 'healthy';
        const reading = value === undefined || value === null || !Number.isFinite(value)
          ? 'Unavailable'
          : `${value.toFixed(1)}${unit}`;
        return <div className="notification-health-item" key={label} title={`${label}: ${reading}`}>
          <span className={`notification-health-light notification-health-${level}`} aria-hidden="true" />
          <span><strong>{label}</strong><small>{reading}</small></span>
        </div>;
      })}
    </footer>
  );
}

function initialTheme(): Theme {
  try {
    const saved = window.localStorage.getItem('symbiote-theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

async function api<T>(endpoint: string, options?: RequestInit): Promise<T> {
  let token = '';
  try {
    token = window.sessionStorage.getItem('symbiote-lan-token') ?? '';
  } catch {
    // A local connection still works if browser storage is unavailable.
  }
  const response = await fetch(endpoint, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options?.headers,
    },
  });
  const payload = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload as T;
}

async function streamApi<T>(
  endpoint: string,
  body: Record<string, unknown>,
  onEvent: (event: Record<string, unknown>) => void,
): Promise<{ complete: true; result: T } | { complete: false }> {
  let token = '';
  try {
    token = window.sessionStorage.getItem('symbiote-lan-token') ?? '';
  } catch {
    // The same-origin desktop/local session does not require a LAN token.
  }
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error || `Request failed (${response.status})`);
  }
  if (!response.body) throw new Error('Streaming response body is unavailable.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalResult: T | undefined;
  const processEvent = (block: string) => {
    const data = block.split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) return;
    const event = JSON.parse(data) as Record<string, unknown>;
    if (event.type === 'error') throw new Error(typeof event.error === 'string' ? event.error : 'The agent turn failed.');
    if (event.type === 'done') finalResult = event.result as T;
    else onEvent(event);
  };
  const consume = (chunk: string, flush = false) => {
    buffer += chunk;
    const delimiter = /\r?\n\r?\n/g;
    let start = 0;
    for (let match = delimiter.exec(buffer); match; match = delimiter.exec(buffer)) {
      processEvent(buffer.slice(start, match.index));
      start = delimiter.lastIndex;
    }
    buffer = buffer.slice(start);
    if (flush && buffer.trim()) {
      processEvent(buffer);
      buffer = '';
    }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      consume(decoder.decode(value, { stream: true }));
    }
    consume(decoder.decode(), true);
  } finally {
    reader.releaseLock();
  }
  return finalResult === undefined ? { complete: false } : { complete: true, result: finalResult };
}

function formatRelative(timestamp?: number): string {
  if (!timestamp) return 'No activity yet';
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 60_000) return 'Just now';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return new Date(timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function notificationTimestamp(timestamp: number): string {
  return formatRelative(timestamp);
}

function findSavedAssistantResponse(messages: ChatMessage[], userText: string): ChatMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== 'user' || !(message.content === userText || message.content.endsWith(`] ${userText}`))) continue;
    return messages.slice(index + 1).find(item => item.role === 'assistant');
  }
  return undefined;
}

function MinimalMode({ theme, onThemeChange }: { theme: Theme; onThemeChange: () => void }) {
  const [tab, setTab] = useState<'chat' | 'history' | 'agents' | 'tasks'>('chat');
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [agents, setAgents] = useState<WorkspaceAgent[]>([]);
  const [runs, setRuns] = useState<WorkspaceRun[]>([]);
  const [text, setText] = useState('');
  const [opacity, setOpacity] = useState(0.88);
  const [busy, setBusy] = useState(false);
  const [activeTurnSessionId, setActiveTurnSessionId] = useState('');
  const [error, setError] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const conversations = useMemo(() => sessions.filter(session => session.sessionKind !== 'subagent'), [sessions]);

  const refresh = useCallback(async () => {
    try {
      const [sessionList, runList, agentList] = await Promise.all([
        api<SessionSummary[]>('/api/sessions'),
        api<WorkspaceRun[]>('/api/runs'),
        api<WorkspaceAgent[]>('/api/agents'),
      ]);
      setSessions(sessionList);
      setRuns(runList);
      setAgents(agentList);
      setActiveSessionId(current => current || sessionList.find(session => session.sessionKind !== 'subagent')?.id || '');
      setError('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not refresh the workspace.');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    void window.symbioteDesktop?.getOpacity().then(setOpacity).catch(failure => {
      setError(failure instanceof Error ? failure.message : 'Could not read overlay transparency.');
    });
  }, []);

  useEffect(() => {
    if (!activeSessionId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    void api<ChatMessage[]>(`/api/sessions/${encodeURIComponent(activeSessionId)}/messages`)
      .then(result => { if (!cancelled) setMessages(result); })
      .catch(failure => { if (!cancelled) setError(failure instanceof Error ? failure.message : 'Could not load conversation.'); });
    return () => { cancelled = true; };
  }, [activeSessionId]);

  useEffect(() => {
    if (tab === 'chat') scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, tab]);

  const newConversation = async () => {
    try {
      const session = await api<SessionSummary>('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({ name: 'Conversation' }),
      });
      setSessions(current => [session, ...current.filter(item => item.id !== session.id)]);
      setActiveSessionId(session.id);
      setTab('chat');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not start a conversation.');
    }
  };

  const sendMessage = async (event: FormEvent) => {
    event.preventDefault();
    const message = text.trim();
    if (!message || !activeSessionId || busy) return;
    setText('');
    setBusy(true);
    const assistantId = createClientId();
    let streamedText = '';
    setActiveTurnSessionId(activeSessionId);
    setMessages(current => [...current, { id: `pending-${Date.now()}`, role: 'user', content: message, timestamp: Date.now() }, { id: assistantId, role: 'assistant', content: '', streaming: true, timestamp: Date.now() }]);
    try {
      const outcome = await streamApi<{ text: string }>('/api/chat', { text: message, sessionId: activeSessionId }, event => {
        setMessages(current => current.map(item => item.id === assistantId
          ? event.type === 'text_delta'
            ? { ...item, content: item.content + String(event.text ?? '') }
            : item
          : item));
        if (event.type === 'text_delta') streamedText += String(event.text ?? '');
      });
      if (!outcome.complete) {
        const saved = await api<ChatMessage[]>(`/api/sessions/${encodeURIComponent(activeSessionId)}/messages`);
        const latestAssistant = findSavedAssistantResponse(saved, message);
        if (latestAssistant) {
          setMessages(saved);
        } else {
          setMessages(current => current.map(item => item.id === assistantId
            ? { ...item, content: streamedText, streaming: false, interrupted: true }
            : item));
        }
        return;
      }
      const result = outcome.result;
      await refresh();
      const saved = await api<ChatMessage[]>(`/api/sessions/${encodeURIComponent(activeSessionId)}/messages`);
      setMessages(saved.length ? saved : current => current.map(item => item.id === assistantId ? { ...item, content: result.text, streaming: false } : item));
    } catch (failure) {
      setMessages(current => current.map(item => item.id === assistantId ? {
        ...item,
        content: item.content || streamedText || (failure instanceof Error ? failure.message : 'The agent turn failed.'),
        streaming: false,
        interrupted: true,
      } : item));
    } finally {
      setBusy(false);
      setActiveTurnSessionId('');
    }
  };

  const updateOpacity = async (value: number) => {
    setOpacity(value);
    try {
      await window.symbioteDesktop?.setOpacity(value);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not update overlay transparency.');
    }
  };

  return (
    <div className="control-room minimal-mode" data-theme={theme}>
      <section className="minimal-card" aria-label="Symbiote mini chat">
        <header className="minimal-header">
          <span className="minimal-drag"><Biohazard size={16} /> <strong>Symbiote</strong></span>
          <div className="minimal-header-actions">
            <button className="minimal-icon-button" onClick={onThemeChange} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} title="Change appearance">{theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}</button>
            <button className="minimal-icon-button" onClick={() => void window.symbioteDesktop?.expand()} aria-label="Open full application" title="Expand"><Maximize2 size={15} /></button>
            <button className="minimal-icon-button" onClick={() => void window.symbioteDesktop?.closeMini()} aria-label="Close mini window" title="Close"><X size={16} /></button>
          </div>
        </header>
        <nav className="minimal-tabs" aria-label="Mini window sections">
          {([
            ['chat', MessageSquare, 'Chat'],
            ['history', History, 'History'],
            ['agents', Users, 'Agents'],
            ['tasks', Activity, 'Tasks'],
          ] as const).map(([id, Icon, label]) => (
            <button key={id} className={tab === id ? 'minimal-tab minimal-tab-active' : 'minimal-tab'} onClick={() => setTab(id)}>
              <Icon size={14} /><span>{label}</span>
            </button>
          ))}
        </nav>
        {error && <div className="minimal-error" role="alert">{error}</div>}
        {tab === 'chat' && <>
          <div className="minimal-session-row">
            <select aria-label="Select conversation" value={activeSessionId} onChange={event => setActiveSessionId(event.target.value)}>
              {conversations.map(session => <option key={session.id} value={session.id}>{session.label || 'Conversation'}</option>)}
            </select>
            <button className="minimal-icon-button" onClick={() => void newConversation()} aria-label="New conversation" title="New conversation"><Plus size={16} /></button>
          </div>
          <div className="minimal-messages" ref={scrollRef}>
            {messages.length === 0 && <p className="minimal-empty">Start a conversation.</p>}
            {messages.map(message => <article className={`minimal-message minimal-message-${message.role}`} key={message.id}><span>{message.role === 'user' ? 'You' : 'Agent'}</span>{message.content && <MessageBody content={message.content} />}{message.interrupted && <small className="message-interrupted">This reply did not finish. Your message is preserved; you can try again.</small>}</article>)}
          </div>
          <form className="minimal-composer" onSubmit={event => void sendMessage(event)}>
            <textarea value={text} onChange={event => setText(event.target.value)} rows={2} placeholder="Write a message…" aria-label="Message" onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
            {busy
              ? <button type="button" onClick={() => void api(`/api/sessions/${encodeURIComponent(activeTurnSessionId)}/interrupt`, { method: 'POST' }).catch(failure => setError(failure instanceof Error ? failure.message : 'Could not interrupt the agent turn.'))} aria-label="Stop agent turn" title="Stop"><X size={16} /></button>
              : <button type="submit" disabled={!text.trim() || !activeSessionId} aria-label="Send message" title="Send"><ArrowRight size={16} /></button>}
          </form>
        </>}
        {tab === 'history' && <div className="minimal-list">
          {conversations.map(session => <button key={session.id} className="minimal-list-item" onClick={() => { setActiveSessionId(session.id); setTab('chat'); }}><span><strong>{session.label || 'Conversation'}</strong><small>{session.messageCount} messages · {formatRelative(session.updatedAt)}</small></span><ArrowRight size={14} /></button>)}
          {conversations.length === 0 && <p className="minimal-empty">No conversations yet.</p>}
        </div>}
        {tab === 'agents' && <div className="minimal-list">
          {agents.map(agent => <div key={agent.sessionId} className="minimal-list-item"><span><strong>{agent.task}</strong><small>{agent.status} · {agent.sessionId.slice(0, 8)}</small></span>{agent.status === 'running' ? <button className="minimal-icon-button" onClick={() => void api(`/api/agents/${encodeURIComponent(agent.sessionId)}/action`, { method: 'POST', body: JSON.stringify({ action: 'stop' }) }).then(refresh).catch(failure => setError(failure instanceof Error ? failure.message : 'Could not stop subagent.'))} aria-label={`Stop ${agent.task}`} title="Stop subagent"><X size={14} /></button> : <span className={`minimal-status minimal-status-${agent.status}`} />}</div>)}
          {agents.length === 0 && <p className="minimal-empty">No subagents yet.</p>}
        </div>}
        {tab === 'tasks' && <div className="minimal-list">
          {runs.map(run => <div key={run.id} className="minimal-list-item"><span><strong>{run.name}</strong><small>{run.status} · {formatRelative(run.startedAt)}</small></span>{run.status === 'running' ? <button className="minimal-icon-button" onClick={() => void api(`/api/runs/${encodeURIComponent(run.id)}/stop`, { method: 'POST' }).then(refresh).catch(failure => setError(failure instanceof Error ? failure.message : 'Could not stop task.'))} aria-label={`Stop ${run.name}`} title="Stop task"><X size={14} /></button> : <span className={`minimal-status minimal-status-${run.status}`} />}</div>)}
          {runs.length === 0 && <p className="minimal-empty">No agent tasks yet.</p>}
        </div>}
        <footer className="minimal-footer">
          <span>Overlay opacity</span>
          <input type="range" min="0.35" max="1" step="0.01" value={opacity} onChange={event => void updateOpacity(Number(event.target.value))} aria-label="Overlay opacity" />
          <span>{Math.round(opacity * 100)}%</span>
        </footer>
      </section>
    </div>
  );
}

function formatBytes(megabytes?: number): string {
  if (typeof megabytes !== 'number') return '—';
  return megabytes >= 1024 ? `${(megabytes / 1024).toFixed(1)} GB` : `${Math.round(megabytes)} MB`;
}

function formatSystemBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function formatRate(bytesPerSecond: number | null | undefined): string {
  return bytesPerSecond === null ? '—' : `${formatSystemBytes(bytesPerSecond)}/s`;
}

function formatElapsed(startedAt: number, completedAt?: number): string {
  const elapsed = Math.max(0, (completedAt ?? Date.now()) - startedAt);
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1000)}s`;
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ${Math.floor((elapsed % 60_000) / 1000)}s`;
  return `${Math.floor(elapsed / 3_600_000)}h ${Math.floor((elapsed % 3_600_000) / 60_000)}m`;
}

function initials(label?: string): string {
  return (label || 'S').trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase();
}

function agentIcon(emoji?: string) {
  if (emoji === '🧠') return Brain;
  if (emoji === '🧭') return Compass;
  if (emoji === '🌿') return Leaf;
  if (emoji === '✨') return Sparkles;
  return Bot;
}

function MessageBody({ content }: { content: string }) {
  return (
    <div className="message-markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          table: ({ children }) => <div className="markdown-table-scroll"><table>{children}</table></div>,
          img: ({ src, alt }) => src ? <figure className="markdown-image"><img src={src} alt={alt ?? ''} loading="lazy" decoding="async" /><figcaption>{alt}</figcaption></figure> : null,
        }}
      >{content}</Markdown>
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  const points = values.length > 1
    ? values.map((value, index) => {
      const min = Math.min(...values);
      const range = Math.max(1, Math.max(...values) - min);
      return `${(index / (values.length - 1)) * 180},${38 - ((value - min) / range) * 31}`;
    }).join(' ')
    : '0,30 180,30';
  return (
    <svg className="sparkline" viewBox="0 0 180 42" role="img" aria-label="Recent memory use trend">
      <path d="M0 40H180" className="sparkline-baseline" />
      <polyline points={points} className="sparkline-line" />
    </svg>
  );
}

function EmptyState({ icon: Icon, title, detail, action }: {
  icon: typeof MessageSquare;
  title: string;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon"><Icon size={19} strokeWidth={1.7} /></span>
      <h3>{title}</h3>
      <p>{detail}</p>
      {action}
    </div>
  );
}

function AccessGate({ onUnlock, error }: { onUnlock: (token: string) => Promise<void>; error: string }) {
  const [token, setToken] = useState('');
  const [checking, setChecking] = useState(false);
  return (
    <main className="access-gate" data-theme={initialTheme()}>
      <form className="access-card" onSubmit={event => {
        event.preventDefault();
        setChecking(true);
        void onUnlock(token).finally(() => setChecking(false));
      }}>
        <span className="welcome-mark"><ShieldCheck size={20} /></span>
        <div className="eyebrow">NETWORK ACCESS</div>
        <h1>Connect to Symbiote</h1>
        <p>Enter the LAN access token from the host’s `.session` directory.</p>
        <label htmlFor="lan-access-token">Access token</label>
        <input id="lan-access-token" type="password" autoComplete="current-password" value={token} onChange={event => setToken(event.target.value)} required />
        {error && <div className="notice notice-error" role="alert">{error}</div>}
        <button className="button button-primary" type="submit" disabled={checking || !token.trim()}>
          {checking ? <LoaderCircle size={15} className="spin" /> : <ArrowRight size={15} />}
          {checking ? 'Checking…' : 'Connect'}
        </button>
      </form>
    </main>
  );
}

function CommandPalette({ query, onQuery, onClose, onNavigate, onNewSession }: {
  query: string;
  onQuery: (value: string) => void;
  onClose: () => void;
  onNavigate: (view: ViewId) => void;
  onNewSession: () => void;
}) {
  const commands = [
    ...NAVIGATION.map(item => ({ label: item.label, detail: `Open ${item.group.toLowerCase()}`, icon: item.icon, run: () => onNavigate(item.id) })),
    { label: 'New conversation', detail: 'Start a fresh session', icon: Plus, run: onNewSession },
  ].filter(command => `${command.label} ${command.detail}`.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <section className="command-palette" role="dialog" aria-modal="true" aria-label="Command menu" onMouseDown={event => event.stopPropagation()}>
        <div className="palette-search"><Search size={17} /><input autoFocus value={query} onChange={event => onQuery(event.target.value)} onKeyDown={event => {
          if (event.key === 'Enter' && commands[0]) {
            event.preventDefault();
            commands[0].run();
          }
        }} placeholder="Where would you like to go?" aria-label="Search commands" /><kbd>ESC</kbd></div>
        <div className="palette-results">
          {commands.length ? commands.map(command => {
            const Icon = command.icon;
            return <button key={command.label} onClick={command.run}><Icon size={16} /><span><strong>{command.label}</strong><small>{command.detail}</small></span><ArrowRight size={14} /></button>;
          }) : <p className="palette-empty">No matching actions.</p>}
        </div>
        <div className="palette-footer"><span><kbd>↵</kbd> Select an action</span><span><kbd>⌘ K</kbd> Open command menu</span></div>
      </section>
    </div>
  );
}

export default function App() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const isMinimalMode = new URLSearchParams(window.location.search).get('minimal') === '1';
  const isDesktopApp = new URLSearchParams(window.location.search).get('desktop') === '1' && Boolean(window.symbioteDesktop);
  const [view, setView] = useState<ViewId>('workspace');
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [config, setConfig] = useState<GatewayConfig | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [tools, setTools] = useState<ToolSummary[]>([]);
  const [runs, setRuns] = useState<WorkspaceRun[]>([]);
  const [agents, setAgents] = useState<WorkspaceAgent[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [logLines, setLogLines] = useState('');
  const [memoryHistory, setMemoryHistory] = useState<number[]>([]);
  const [hostHistory, setHostHistory] = useState<HostResourceSnapshot[]>([]);
  const [gatewayConnected, setGatewayConnected] = useState(false);
  const [accessChecked, setAccessChecked] = useState(false);
  const [accessRequired, setAccessRequired] = useState(false);
  const [accessGranted, setAccessGranted] = useState(false);
  const [accessError, setAccessError] = useState('');
  const [activeSessionId, setActiveSessionId] = useState('');
  const [sessionDrafts, setSessionDrafts] = useState<Record<string, string>>(() => {
    try {
      const stored = window.localStorage.getItem('symbiote-session-drafts');
      const parsed: unknown = stored ? JSON.parse(stored) : {};
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, string> : {};
    } catch {
      return {};
    }
  });
  const [sessionQuery, setSessionQuery] = useState('');
  const [toolQuery, setToolQuery] = useState('');
  const [logQuery, setLogQuery] = useState('');
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const [identityOpen, setIdentityOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [relativeTimeNow, setRelativeTimeNow] = useState(Date.now());
  const [readNotificationIds, setReadNotificationIds] = useState<string[]>(() => {
    try {
      const stored = window.localStorage.getItem('symbiote-read-notifications');
      const parsed: unknown = stored ? JSON.parse(stored) : [];
      return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
    } catch {
      return [];
    }
  });
  const [deviceNotificationPermission, setDeviceNotificationPermission] = useState(() =>
    typeof Notification === 'undefined' || !window.isSecureContext ? 'unsupported' : Notification.permission,
  );
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sending, setSending] = useState(false);
  const [creatingSession, setCreatingSession] = useState(false);
  const [startingRun, setStartingRun] = useState(false);
  const [error, setError] = useState('');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const activeTurnSessionId = useRef<string | null>(null);
  const nativeNotifiedIds = useRef(new Set<string>());
  const sessionSearchRef = useRef<HTMLInputElement>(null);
  const toolSearchRef = useRef<HTMLInputElement>(null);
  const logSearchRef = useRef<HTMLInputElement>(null);
  const activeSession = sessions.find(session => session.id === activeSessionId);
  const currentNavigation = NAVIGATION.find(item => item.id === view) ?? NAVIGATION[0];
  const sessionDraft = sessionDrafts[activeSessionId] ?? '';

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.title = 'Control Room';
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#171d19' : '#f3f2eb');
    try {
      window.localStorage.setItem('symbiote-theme', theme);
    } catch {
      // The current page theme still works when persistent storage is unavailable.
    }
  }, [theme]);

  useEffect(() => {
    const timer = window.setInterval(() => setRelativeTimeNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem('symbiote-read-notifications', JSON.stringify(readNotificationIds.slice(-200)));
    } catch {
      // The current notification state remains available for this page lifetime.
    }
  }, [readNotificationIds]);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem('symbiote-device-notified');
      const parsed: unknown = stored ? JSON.parse(stored) : [];
      if (Array.isArray(parsed)) nativeNotifiedIds.current = new Set(parsed.filter((value): value is string => typeof value === 'string'));
    } catch {
      setError('Saved device notification state could not be read.');
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem('symbiote-session-drafts', JSON.stringify(sessionDrafts));
    } catch {
      setError('Drafts could not be saved in this browser.');
    }
  }, [sessionDrafts]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const isEditing = target instanceof HTMLElement &&
        (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandOpen(true);
        setCommandQuery('');
      } else if (event.key === '/' && !isEditing) {
        const search = view === 'sessions' ? sessionSearchRef.current : view === 'tools' ? toolSearchRef.current : view === 'operations' ? logSearchRef.current : null;
        if (search) {
          event.preventDefault();
          search.focus();
        }
      } else if (event.key === 'Escape') {
        setCommandOpen(false);
        setIdentityOpen(false);
        setMobileNavOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [view]);

  const refreshStatus = useCallback(async () => {
    try {
      const fresh = await api<GatewayStatus>('/api/status');
      setStatus(fresh);
      setGatewayConnected(true);
      setMemoryHistory(previous => [...previous.slice(-59), fresh.memory?.rss ?? 0]);
      const hostSample = fresh.metrics?.system?.host;
      if (hostSample?.sampledAt) {
        setHostHistory(previous => previous[previous.length - 1]?.sampledAt === hostSample.sampledAt
          ? previous
          : [...previous.slice(-59), hostSample]);
      }
      setLastUpdated(Date.now());
    } catch (failure) {
      setGatewayConnected(false);
      throw failure;
    }
  }, []);

  const refreshWork = useCallback(async () => {
    const [freshRuns, freshAgents] = await Promise.all([
      api<WorkspaceRun[]>('/api/runs'),
      api<WorkspaceAgent[]>('/api/agents'),
    ]);
    setRuns(freshRuns);
    setAgents(freshAgents);
  }, []);

  const refreshAll = useCallback(async (showSpinner = false) => {
    if (showSpinner) setRefreshing(true);
    setError('');
    const results = await Promise.allSettled([
      refreshStatus(),
      api<GatewayConfig>('/api/config').then(setConfig),
      api<SessionSummary[]>('/api/sessions').then(data => {
        setSessions(data);
        setActiveSessionId(current => current && data.some(item => item.id === current) ? current : data[0]?.id ?? '');
      }),
      api<ToolSummary[]>('/api/tools').then(setTools),
      refreshWork(),
    ]);
    const firstError = results.find(result => result.status === 'rejected');
    if (firstError?.status === 'rejected') setError(firstError.reason instanceof Error ? firstError.reason.message : 'Could not load gateway data.');
    setLoading(false);
    if (showSpinner) setRefreshing(false);
  }, [refreshStatus, refreshWork]);

  const unlockLanAccess = async (token: string) => {
    setAccessError('');
    try {
      window.sessionStorage.setItem('symbiote-lan-token', token.trim());
      const access = await api<{ required: boolean; authenticated: boolean }>('/api/access');
      if (!access.authenticated) {
        window.sessionStorage.removeItem('symbiote-lan-token');
        setAccessError('That token was not accepted.');
        return;
      }
      setAccessRequired(access.required);
      setAccessGranted(true);
      await refreshAll();
    } catch (failure) {
      window.sessionStorage.removeItem('symbiote-lan-token');
      setAccessError(failure instanceof Error ? failure.message : 'Could not verify this token.');
    }
  };

  useEffect(() => {
    let cancelled = false;
    api<{ required: boolean; authenticated: boolean }>('/api/access')
      .then(access => {
        if (cancelled) return;
        setAccessRequired(access.required);
        setAccessGranted(access.authenticated);
        setAccessChecked(true);
        if (access.authenticated) void refreshAll();
        else setLoading(false);
      })
      .catch(failure => {
        if (cancelled) return;
        setAccessChecked(true);
        setLoading(false);
        setError(failure instanceof Error ? failure.message : 'Could not check LAN access.');
      });
    return () => { cancelled = true; };
  }, [refreshAll]);

  useEffect(() => {
    if (!accessGranted) return;
    const statusTimer = window.setInterval(() => {
      void refreshStatus().catch(() => setError('Gateway connection was interrupted. Retrying…'));
    }, view === 'workspace' ? 3000 : 5000);
    const activityTimer = window.setInterval(() => {
      if (view === 'workspace' || view === 'runs' || view === 'agents') {
        void refreshWork().catch(failure => setError(failure instanceof Error ? failure.message : 'Could not refresh workspace activity.'));
      }
      if (view === 'operations') {
        void api<{ lines: string }>('/api/logs?lines=120')
          .then(result => setLogLines(result.lines))
          .catch(() => undefined);
      }
    }, 5000);
    return () => {
      window.clearInterval(statusTimer);
      window.clearInterval(activityTimer);
    };
  }, [accessGranted, refreshStatus, refreshWork, view]);

  useEffect(() => {
    if (!activeSessionId) {
      setMessages([]);
      return;
    }
    const controller = new AbortController();
    api<unknown[]>(`/api/sessions/${encodeURIComponent(activeSessionId)}/messages`, { signal: controller.signal })
      .then(items => {
        const display: ChatMessage[] = [];
        for (const item of items) {
          if (!item || typeof item !== 'object') continue;
          const message = item as Record<string, unknown>;
          const role = message.role;
          const content = typeof message.content === 'string'
            ? message.content
            : Array.isArray(message.content)
              ? message.content.map(block => block && typeof block === 'object' && 'text' in block ? String(block.text) : '').filter(Boolean).join('\n')
              : '';
          if ((role === 'user' || role === 'assistant') && content.trim()) {
            display.push({
              id: String(message.id ?? `${role}-${display.length}`),
              role,
              content,
              timestamp: typeof message.timestamp === 'number' ? message.timestamp : undefined,
            });
          }
        }
        setMessages(display);
      })
      .catch(failure => {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Could not load conversation.');
      });
    return () => controller.abort();
  }, [activeSessionId]);

  useEffect(() => {
    if (view === 'operations') {
      void api<{ lines: string }>('/api/logs?lines=120')
        .then(result => setLogLines(result.lines))
        .catch(failure => setError(failure instanceof Error ? failure.message : 'Could not load service log.'));
    }
  }, [view]);

  useEffect(() => {
    if (view === 'chat') bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, sending, view]);

  const filteredSessions = useMemo(() => {
    const query = sessionQuery.trim().toLowerCase();
    return query
      ? sessions.filter(session => `${session.label ?? ''} ${session.id}`.toLowerCase().includes(query))
      : sessions;
  }, [sessions, sessionQuery]);

  const filteredTools = useMemo(() => {
    const query = toolQuery.trim().toLowerCase();
    return query
      ? tools.filter(tool => `${tool.name} ${tool.description}`.toLowerCase().includes(query))
      : tools;
  }, [tools, toolQuery]);

  const navigate = (destination: ViewId) => {
    setView(destination);
    setMobileNavOpen(false);
    setError('');
  };

  const createSession = async () => {
    setCreatingSession(true);
    setError('');
    try {
      const created = await api<{ id: string }>('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({ name: 'New conversation' }),
      });
      await refreshAll();
      setActiveSessionId(created.id);
      navigate('chat');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not create a conversation.');
    } finally {
      setCreatingSession(false);
    }
  };

  const launchRun = async (prompt: string, selectedSessionId: string): Promise<boolean> => {
    setStartingRun(true);
    setError('');
    try {
      let sessionId = selectedSessionId;
      if (!sessionId) {
        const created = await api<{ id: string; name?: string; createdAt: number }>('/api/sessions', {
          method: 'POST',
          body: JSON.stringify({ name: 'New conversation' }),
        });
        sessionId = created.id;
        setActiveSessionId(sessionId);
        setSessions(previous => [{ id: sessionId, label: created.name, createdAt: created.createdAt, updatedAt: created.createdAt, messageCount: 0 }, ...previous]);
      }
      const run = await api<WorkspaceRun>('/api/runs', {
        method: 'POST',
        body: JSON.stringify({ prompt, sessionId }),
      });
      setRuns(previous => [run, ...previous.filter(item => item.id !== run.id)]);
      void refreshWork().catch(failure => setError(failure instanceof Error ? failure.message : 'Could not load the new run.'));
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not start task.');
      return false;
    } finally {
      setStartingRun(false);
    }
  };

  const stopRun = async (id: string) => {
    try {
      await api(`/api/runs/${encodeURIComponent(id)}/stop`, { method: 'POST' });
      await refreshWork();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not stop the run.');
    }
  };

  const restartRun = async (id: string) => {
    try {
      const run = await api<WorkspaceRun>(`/api/runs/${encodeURIComponent(id)}/restart`, { method: 'POST' });
      setRuns(previous => [run, ...previous.filter(item => item.id !== run.id)]);
      await refreshWork();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not restart the task.');
    }
  };

  const guideRun = async (id: string, message: string) => {
    try {
      const run = await api<WorkspaceRun>(`/api/runs/${encodeURIComponent(id)}/guide`, {
        method: 'POST',
        body: JSON.stringify({ message }),
      });
      setRuns(previous => [run, ...previous.filter(item => item.id !== run.id)]);
      await refreshWork();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not send guidance.');
    }
  };

  const updateIdentity = async (identity: { name: string; emoji: string; soulContent: string; agentsContent: string; instructions: string }) => {
    try {
      const updated = await api<GatewayConfig>('/api/identity', {
        method: 'PUT',
        body: JSON.stringify(identity),
      });
      setConfig(current => current ? { ...current, ...updated } : updated);
      setIdentityOpen(false);
      setError('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not save agent identity.');
      throw failure;
    }
  };

  const controlAgent = async (id: string, action: 'stop' | 'steer', message?: string) => {
    try {
      await api(`/api/agents/${encodeURIComponent(id)}/action`, {
        method: 'POST',
        body: JSON.stringify({ action, message }),
      });
      await refreshWork();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not control the subagent.');
    }
  };

  const openRunSession = (sessionId: string) => {
    setActiveSessionId(sessionId);
    navigate('chat');
  };

  const archiveSession = async (id: string) => {
    try {
      await api(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const remaining = sessions.filter(session => session.id !== id);
      setSessions(remaining);
      if (activeSessionId === id) {
        setActiveSessionId(remaining[0]?.id ?? '');
        if (!remaining.length) navigate('sessions');
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not archive conversation.');
    }
  };

  const sendMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = sessionDraft.trim();
    if (!text || !activeSessionId || sending) return;
    const userMessage: ChatMessage = { id: createClientId(), role: 'user', content: text, timestamp: Date.now() };
    const assistantId = createClientId();
    let streamedText = '';
    activeTurnSessionId.current = activeSessionId;
    setMessages(previous => [...previous, userMessage, { id: assistantId, role: 'assistant', content: '', timestamp: Date.now(), streaming: true }]);
    setSending(true);
    setSessionDrafts(previous => {
      const next = { ...previous };
      delete next[activeSessionId];
      return next;
    });
    setError('');
    try {
      const outcome = await streamApi<{
        text: string;
        durationMs?: number;
        iterations?: number;
        toolCalls?: Array<{ name: string; input: Record<string, unknown>; result: string }>;
      }>('/api/chat', { text, sessionId: activeSessionId }, streamed => {
        setMessages(previous => previous.map(message => {
          if (message.id !== assistantId) return message;
          if (streamed.type === 'text_delta') {
            const delta = String(streamed.text ?? '');
            streamedText += delta;
            return { ...message, content: message.content + delta, thinking: false };
          }
          if (streamed.type === 'thinking_delta') return { ...message, thinking: true };
          if (streamed.type === 'tool_start') {
            const name = String(streamed.name ?? 'tool');
            return { ...message, thinking: false, activeTools: [...(message.activeTools ?? []), name] };
          }
          if (streamed.type === 'tool_end') {
            const name = String(streamed.name ?? 'tool');
            return { ...message, activeTools: (message.activeTools ?? []).filter(tool => tool !== name) };
          }
          return message;
        }));
      });
      if (!outcome.complete) {
        const saved = await api<ChatMessage[]>(`/api/sessions/${encodeURIComponent(activeSessionId)}/messages`);
        const latestAssistant = findSavedAssistantResponse(saved, text);
        if (latestAssistant) {
          setMessages(saved);
          void api<SessionSummary[]>('/api/sessions').then(setSessions).catch(() => undefined);
        } else {
          setMessages(previous => previous.map(message => message.id === assistantId ? {
            ...message,
            content: streamedText,
            streaming: false,
            thinking: false,
            activeTools: [],
            interrupted: true,
          } : message));
        }
        return;
      }
      const response = outcome.result;
      setMessages(previous => previous.map(message => message.id === assistantId ? {
        ...message,
        content: response.text || message.content || 'The turn completed without a text response.',
        streaming: false,
        thinking: false,
        activeTools: [],
        timestamp: Date.now(),
        durationMs: response.durationMs,
        iterations: response.iterations,
        toolCalls: response.toolCalls ?? [],
      } : message));
      void api<SessionSummary[]>('/api/sessions').then(setSessions).catch(() => undefined);
      void refreshStatus().catch(() => undefined);
    } catch (failure) {
      setMessages(previous => previous.map(message => message.id === assistantId ? {
        ...message,
        content: message.content || streamedText || (failure instanceof Error ? failure.message : 'The agent turn failed.'),
        streaming: false,
        thinking: false,
        activeTools: [],
        interrupted: true,
      } : message));
    } finally {
      activeTurnSessionId.current = null;
      setSending(false);
    }
  };

  const interruptChat = async () => {
    const sessionId = activeTurnSessionId.current;
    if (!sessionId || !sending) return;
    try {
      await api(`/api/sessions/${encodeURIComponent(sessionId)}/interrupt`, { method: 'POST' });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not interrupt the agent turn.');
    }
  };

  const channelList = status?.channels ?? [];
  const isOnline = gatewayConnected;
  const attentionItems = [
    ...runs.filter(run => run.status === 'failed').map(run => ({
      id: `run-${run.id}-${run.completedAt ?? run.startedAt}`,
      title: run.name,
      detail: run.error || 'The task stopped unexpectedly.',
      timestamp: run.completedAt ?? run.startedAt,
      severity: 3,
      destination: 'runs' as ViewId,
    })),
    ...agents.filter(agent => agent.status === 'failed').map(agent => ({
      id: `agent-${agent.sessionId}-${agent.completedAt ?? agent.startedAt}`,
      title: agent.task,
      detail: agent.error || 'The subagent failed.',
      timestamp: agent.completedAt ?? agent.startedAt,
      severity: 3,
      destination: 'agents' as ViewId,
    })),
    ...runs.filter(run => run.status === 'cancelled').map(run => ({
      id: `run-${run.id}-${run.completedAt ?? run.startedAt}`,
      title: run.name,
      detail: 'The task was stopped before completion.',
      timestamp: run.completedAt ?? run.startedAt,
      severity: 2,
      destination: 'runs' as ViewId,
    })),
    ...(!isOnline ? [{
      id: 'gateway-offline',
      title: 'Gateway connection lost',
      detail: 'The control room cannot reach the local runtime.',
      timestamp: relativeTimeNow,
      severity: 4,
      destination: 'operations' as ViewId,
    }] : []),
  ].sort((left, right) => right.severity - left.severity || right.timestamp - left.timestamp);
  const unreadNotifications = attentionItems.filter(item => !readNotificationIds.includes(item.id));
  const dismissNotification = (id: string) => setReadNotificationIds(previous => previous.includes(id) ? previous : [...previous, id]);

  useEffect(() => {
    if (deviceNotificationPermission !== 'granted' || typeof Notification === 'undefined') return;
    for (const item of unreadNotifications) {
      if (nativeNotifiedIds.current.has(item.id) || relativeTimeNow - item.timestamp > 60 * 60 * 1000) continue;
      nativeNotifiedIds.current.add(item.id);
      try {
        new Notification(item.title, { body: item.detail, tag: item.id });
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : 'A device notification could not be shown.');
      }
    }
    try {
      window.localStorage.setItem('symbiote-device-notified', JSON.stringify([...nativeNotifiedIds.current].slice(-200)));
    } catch {
      setError('Device notification state could not be saved.');
    }
  }, [deviceNotificationPermission, unreadNotifications, relativeTimeNow]);

  const enableDeviceNotifications = async () => {
    if (typeof Notification === 'undefined' || !window.isSecureContext) {
      setError('Device notifications require a supported browser and a secure connection.');
      return;
    }
    try {
      setDeviceNotificationPermission(await Notification.requestPermission());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Device notification permission could not be requested.');
    }
  };

  if (accessChecked && accessRequired && !accessGranted) {
    return <AccessGate onUnlock={unlockLanAccess} error={accessError} />;
  }

  if (isMinimalMode && isDesktopApp) {
    return <MinimalMode theme={theme} onThemeChange={() => setTheme(current => current === 'dark' ? 'light' : 'dark')} />;
  }

  return (
    <div className={`control-room${view === 'chat' ? ' control-room-chat' : ''}`} data-theme={theme}>
      <a className="skip-link" href="#main-content">Skip to content</a>
      <aside className={`sidebar${mobileNavOpen ? ' sidebar-open' : ''}`} aria-label="Main navigation">
        <div className="brand-lockup">
          <Biohazard className="brand-mark" size={17} strokeWidth={1.7} aria-hidden="true" />
          <div className="brand-copy"><span>SYMBIOTE</span></div>
          <button className="icon-button sidebar-dismiss" onClick={() => setMobileNavOpen(false)} aria-label="Close navigation"><X size={17} /></button>
        </div>

        <button type="button" className="workspace-label" onClick={() => setIdentityOpen(true)} aria-label="Open agent identity and behavior settings">
          {(() => {
            const AgentIcon = agentIcon(config?.agentEmoji);
            return <>
              <span className="workspace-avatar"><AgentIcon size={16} aria-hidden="true" /></span>
              <span className="workspace-copy"><strong>{config?.agentName || config?.name || 'Agent'}</strong></span>
              <Settings2 size={14} className="muted-icon" />
            </>;
          })()}
        </button>

        <nav className="sidebar-navigation" aria-label="Sections">
          {['Work', 'Play', 'Runtime'].map(group => (
            <div className="nav-group" key={group}>
              <div className="nav-label">{group}</div>
              {NAVIGATION.filter(item => item.group === group).map(item => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    className={`nav-item${view === item.id ? ' nav-item-active' : ''}`}
                    onClick={() => navigate(item.id)}
                    aria-current={view === item.id ? 'page' : undefined}
                  >
                    <Icon size={17} strokeWidth={1.8} />
                    <span>{item.label}</span>
                    {item.id === 'tools' && <span className="nav-count">{tools.length || '—'}</span>}
                    {item.id === 'runs' && runs.some(run => run.status === 'running') && <span className="nav-count">{runs.filter(run => run.status === 'running').length}</span>}
                    {item.id === 'agents' && agents.some(agent => agent.status === 'running') && <span className="nav-count">{agents.filter(agent => agent.status === 'running').length}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="sidebar-session">
          <div className="sidebar-section-heading"><span>RECENT THREADS</span><button className="icon-button small" onClick={() => void createSession()} aria-label="Start a new conversation"><Plus size={15} /></button></div>
          {sessions.slice(0, 4).map(session => (
            <button key={session.id} className={`recent-thread${activeSessionId === session.id && view === 'chat' ? ' recent-thread-active' : ''}`} onClick={() => { setActiveSessionId(session.id); navigate('chat'); }}>
              <span className="thread-dot" />
              <span className="recent-thread-copy"><strong>{session.label || 'Conversation'}</strong><small>{formatRelative(session.updatedAt)}</small></span>
            </button>
          ))}
          {sessions.length === 0 && <p className="sidebar-empty">Your conversations will appear here.</p>}
        </div>
        <div className="sidebar-footer">
          <span className="version-label">{__SYMBIOTE_VERSION__}</span>
        </div>
      </aside>

      {mobileNavOpen && <button className="mobile-scrim" onClick={() => setMobileNavOpen(false)} aria-label="Close navigation overlay" />}

      <div className="main-column">
        <header className="topbar">
          <div className="topbar-left">
            <button className="icon-button mobile-menu" onClick={() => setMobileNavOpen(true)} aria-label="Open navigation"><Menu size={19} /></button>
            <div className="breadcrumb"><span className="breadcrumb-divider">/</span><strong>{currentNavigation.id}</strong></div>
          </div>
          <div className="topbar-right">
            {isDesktopApp && <button className="icon-button utility-button" onClick={() => void window.symbioteDesktop?.openMini()} aria-label="Open floating mini chat" title="Open floating mini chat"><Minimize2 size={16} /></button>}
            <span className={`live-indicator${isOnline ? ' live-indicator-on' : ''}`}><span />{isOnline ? 'LIVE' : 'OFFLINE'}</span>
            <span className="topbar-separator" />
            <span className="topbar-provider">{status?.provider || 'Runtime unavailable'}</span>
            <button className="icon-button utility-button" onClick={() => { setCommandOpen(true); setCommandQuery(''); }} aria-label="Open command menu (Ctrl+K)" title="Command menu · Ctrl+K">
              <Command size={16} />
            </button>
            <button className="icon-button utility-button" onClick={() => setTheme(current => current === 'dark' ? 'light' : 'dark')} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}>
              {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            <button className={`icon-button refresh-button${refreshing ? ' is-refreshing' : ''}`} onClick={() => void refreshAll(true)} aria-label="Refresh runtime data" disabled={refreshing}>
              <RefreshCw size={16} />
            </button>
            <div className="notification-anchor">
              <button className="icon-button notification-button" type="button" onClick={() => setNotificationsOpen(open => !open)} aria-label={`Notifications${unreadNotifications.length ? `, ${unreadNotifications.length} need attention` : ''}`} aria-expanded={notificationsOpen} title="Notifications">
                <Bell size={17} />
                {!!unreadNotifications.length && <span className="notification-count">{unreadNotifications.length > 99 ? '99+' : unreadNotifications.length}</span>}
              </button>
              {notificationsOpen && <section className="notification-popover" aria-label="Notifications">
                <header>
                  <div><strong>Notifications</strong><small>{unreadNotifications.length} need attention</small></div>
                  <div className="notification-header-actions">
                    {deviceNotificationPermission !== 'granted' && <button className="text-button" onClick={() => void enableDeviceNotifications()} disabled={deviceNotificationPermission === 'unsupported' || deviceNotificationPermission === 'denied'}>
                      {deviceNotificationPermission === 'unsupported' ? 'Device alerts unavailable' : deviceNotificationPermission === 'denied' ? 'Alerts blocked in browser' : 'Enable device alerts'}
                    </button>}
                    {unreadNotifications.length > 0 && <button className="text-button" onClick={() => setReadNotificationIds(previous => [...new Set([...previous, ...unreadNotifications.map(item => item.id)])])}>Mark all read</button>}
                  </div>
                </header>
                {attentionItems.length ? <div className="notification-list">{attentionItems.map(item => <button key={item.id} className={`notification-item${readNotificationIds.includes(item.id) ? ' notification-item-read' : ''}`} onClick={() => { dismissNotification(item.id); navigate(item.destination); setNotificationsOpen(false); }}>
                  <span className={`notification-mark notification-severity-${item.severity}`} />
                  <span className="notification-copy"><strong>{item.title}</strong><small>{item.detail}</small><time>{notificationTimestamp(item.timestamp)}</time></span>
                  {!readNotificationIds.includes(item.id) && <span className="notification-unread" aria-label="Unread" />}
                </button>)}</div> : <p className="notification-empty">Nothing needs your attention.</p>}
                  <ResourceStatusStrip host={status?.metrics?.system?.host} />
                </section>}
            </div>
          </div>
        </header>

        <main id="main-content" className={`main-content${view === 'chat' ? ' main-content-chat' : ''}`}>
          {error && (
            <div className="notice notice-error" role="alert">
              <span>{error}</span>
              <button className="icon-button small" onClick={() => void refreshAll(true)} aria-label="Retry"><RefreshCw size={14} /></button>
            </div>
          )}

          {loading && !status ? (
            <div className="loading-state"><LoaderCircle size={22} className="spin" /><span>Connecting to your local runtime…</span></div>
          ) : (
            <>
              {view === 'workspace' && (
                <OverviewView
                  status={status}
                  config={config}
                  sessions={sessions}
                  activeSessionId={activeSessionId}
                  runs={runs}
                  agents={agents}
                  channels={channelList}
                  memoryHistory={memoryHistory}
                  hostHistory={hostHistory}
                  lastUpdated={lastUpdated}
                  onNavigate={navigate}
                  onStartRun={launchRun}
                  startingRun={startingRun}
                  onNewSession={() => void createSession()}
                  onOpenSession={id => { setActiveSessionId(id); navigate('chat'); }}
                  creatingSession={creatingSession}
                />
              )}
              {view === 'runs' && (
                <RunsView
                  runs={runs}
                  agents={agents}
                  onStop={stopRun}
                  onRestart={restartRun}
                  onGuide={guideRun}
                  onOpenSession={openRunSession}
                />
              )}
              {view === 'agents' && (
                <AgentsView agents={agents} onControl={controlAgent} />
              )}
              {view === 'chat' && (
                <ChatView
                  session={activeSession}
                  sessions={sessions}
                  messages={messages}
                  draft={sessionDraft}
                  sending={sending}
                  onDraft={value => setSessionDrafts(previous => ({ ...previous, [activeSessionId]: value }))}
                  onSubmit={sendMessage}
                  onStop={() => void interruptChat()}
                  onNewSession={() => void createSession()}
                  onSelectSession={id => setActiveSessionId(id)}
                  onArchiveSession={archiveSession}
                  bottomRef={bottomRef}
                  creatingSession={creatingSession}
                />
              )}
              {view === 'browser' && <BrowserView />}
              {view === 'sessions' && (
                <SessionsView
                  sessions={filteredSessions}
                  query={sessionQuery}
                  onQuery={setSessionQuery}
                  onOpen={id => { setActiveSessionId(id); navigate('chat'); }}
                  onNew={() => void createSession()}
                  creating={creatingSession}
                />
              )}
              {view === 'memory' && <Suspense fallback={<div className="loading-state">Loading memory map…</div>}><MemoryMap request={api} /></Suspense>}
              {view === 'operations' && (
                <OperationsView
                  status={status}
                  channels={channelList}
                  logLines={logLines}
                  query={logQuery}
                  onQuery={setLogQuery}
                  searchRef={logSearchRef}
                  lastUpdated={lastUpdated}
                  onRefresh={() => void refreshAll(true)}
                />
              )}
              {view === 'tools' && (
                <ToolsView tools={filteredTools} total={tools.length} query={toolQuery} onQuery={setToolQuery} />
              )}
              {view === 'settings' && <SettingsView config={config} status={status} />}
              {view === 'games' && <Suspense fallback={<div className="loading-state">Loading games…</div>}><GamesView request={api} /></Suspense>}
            </>
          )}
        </main>
      </div>
      {notificationsOpen && <button className="notification-dismiss" aria-label="Close notifications" onClick={() => setNotificationsOpen(false)} />}
      {identityOpen && config && <AgentSettingsDialog config={config} onSave={updateIdentity} onClose={() => setIdentityOpen(false)} />}
      {commandOpen && <CommandPalette query={commandQuery} onQuery={setCommandQuery} onClose={() => setCommandOpen(false)} onNavigate={destination => { setCommandOpen(false); navigate(destination); }} onNewSession={() => { setCommandOpen(false); void createSession(); }} />}
    </div>
  );
}

function AgentSettingsDialog({ config, onSave, onClose }: {
  config: GatewayConfig;
  onSave: (identity: { name: string; emoji: string; soulContent: string; agentsContent: string; instructions: string }) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(config.agentName || config.name || '');
  const [emoji, setEmoji] = useState(config.agentEmoji || '🤖');
  const [soulContent, setSoulContent] = useState(config.soulContent || '');
  const [agentsContent, setAgentsContent] = useState(config.agentsContent || '');
  const [instructions, setInstructions] = useState(config.agentInstructions || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const choices = [
    { emoji: '🤖', label: 'Automaton', icon: Bot },
    { emoji: '🧠', label: 'Mind', icon: Brain },
    { emoji: '🧭', label: 'Compass', icon: Compass },
    { emoji: '🌿', label: 'Leaf', icon: Leaf },
    { emoji: '✨', label: 'Spark', icon: Sparkles },
  ];
  const AgentIcon = agentIcon(emoji);
  return (
    <div className="identity-backdrop" onMouseDown={onClose}>
      <section className="identity-dialog" role="dialog" aria-modal="true" aria-labelledby="identity-title" onMouseDown={event => event.stopPropagation()}>
        <header className="identity-dialog-header">
          <span className="identity-dialog-icon"><AgentIcon size={20} /></span>
          <div><div className="eyebrow">AGENT PROFILE</div><h2 id="identity-title">Identity & behavior</h2></div>
          <button className="icon-button small" type="button" onClick={onClose} aria-label="Close agent settings"><X size={16} /></button>
        </header>
        <form onSubmit={async event => {
          event.preventDefault();
          setSaving(true);
          setError('');
          try {
            await onSave({ name: name.trim(), emoji, soulContent, agentsContent, instructions });
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : 'Settings could not be saved.');
          } finally {
            setSaving(false);
          }
        }}>
          <label className="identity-field">
            <span>Agent name</span>
            <input value={name} onChange={event => setName(event.target.value)} maxLength={80} required />
          </label>
          <fieldset className="identity-icons">
            <legend>Agent symbol</legend>
            {choices.map(({ emoji: value, label, icon: Icon }) => (
              <button key={value} type="button" className={emoji === value ? 'identity-icon-choice identity-icon-selected' : 'identity-icon-choice'} onClick={() => setEmoji(value)} aria-label={label} aria-pressed={emoji === value}>
                <Icon size={18} /><span>{label}</span>
              </button>
            ))}
          </fieldset>
          <label className="identity-field">
            <span>SOUL.md · agent identity and character</span>
            <textarea className="identity-file-editor" value={soulContent} onChange={event => setSoulContent(event.target.value)} maxLength={100_000} rows={12} spellCheck={false} />
          </label>
          <label className="identity-field">
            <span>AGENTS.md · operating instructions</span>
            <textarea className="identity-file-editor" value={agentsContent} onChange={event => setAgentsContent(event.target.value)} maxLength={100_000} rows={12} spellCheck={false} />
            <small>These editors show the source files verbatim. Saving writes your edits into both workspace files.</small>
          </label>
          <label className="identity-field">
            <span>Additional system-prompt instructions</span>
            <textarea value={instructions} onChange={event => setInstructions(event.target.value)} maxLength={20_000} rows={8} placeholder="Add durable instructions for the agent. These are included in every new turn." />
            <small>Saved in AGENT_INSTRUCTIONS.md and included in each new turn.</small>
          </label>
          {config.ownerName && <div className="identity-owner"><span>Owner</span><strong>{config.ownerName}</strong></div>}
          {error && <div className="notice notice-error" role="alert">{error}</div>}
          <footer className="identity-dialog-actions">
            <button className="button button-secondary" type="button" onClick={onClose}>Cancel</button>
            <button className="button button-primary" type="submit" disabled={saving || !name.trim()}>{saving ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}{saving ? 'Saving' : 'Save identity'}</button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function PageHeading({ eyebrow, title, detail, action }: {
  eyebrow?: string;
  title: string;
  detail?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1>{detail && <p>{detail}</p>}</div>
      {action}
    </div>
  );
}

function OverviewView(props: {
  status: GatewayStatus | null;
  config: GatewayConfig | null;
  sessions: SessionSummary[];
  activeSessionId: string;
  runs: WorkspaceRun[];
  agents: WorkspaceAgent[];
  channels: GatewayStatus['channels'];
  memoryHistory: number[];
  hostHistory: HostResourceSnapshot[];
  lastUpdated: number | null;
  onNavigate: (view: ViewId) => void;
  onStartRun: (prompt: string, sessionId: string) => Promise<boolean>;
  startingRun: boolean;
  onNewSession: () => void;
  onOpenSession: (id: string) => void;
  creatingSession: boolean;
}) {
  const { status, config, sessions, activeSessionId, runs, agents, channels, memoryHistory, hostHistory, lastUpdated, onNavigate, onStartRun, startingRun, onNewSession, onOpenSession, creatingSession } = props;
  const memory = status?.memory;
  const metrics = status?.metrics;
  const host = metrics?.system?.host;
  const temperatureSensor = host?.temperature.sensors.reduce((warmest, sensor) => !warmest || sensor.celsius > warmest.celsius ? sensor : warmest, undefined as HostResourceSnapshot['temperature']['sensors'][number] | undefined);
  const activeResourceAlerts = [
    host?.cpuPercent !== null && host?.cpuPercent !== undefined && host.cpuPercent >= 85
      ? { id: 'cpu', label: `Host CPU is ${host.cpuPercent.toFixed(1)}%` }
      : null,
    host && host.memory.usedPercent >= 85
      ? { id: 'memory', label: `System memory is ${host.memory.usedPercent.toFixed(1)}% used` }
      : null,
    ...(host?.temperature.sensors.filter(sensor => sensor.celsius >= 85).map(sensor => ({
      id: `temperature-${sensor.name}`,
      label: `${sensor.name} reports ${sensor.celsius.toFixed(1)}°C`,
    })) ?? []),
  ].filter((alert): alert is { id: string; label: string } => alert !== null);
  const latestSessions = sessions.slice(0, 4);
  const activeRuns = runs.filter(run => run.status === 'running').length;
  const activeAgents = agents.filter(agent => agent.status === 'running').length;
  const workspacePath = config?.workspace || 'Workspace path unavailable';
  return (
    <div className="page page-overview">
      <PageHeading
        title={(config?.agentName || config?.name || 'Agent').toLowerCase()}
        detail={<WorkspaceClock />}
        action={<button className="button button-primary" onClick={onNewSession} disabled={creatingSession}><Plus size={16} />New conversation</button>}
      />

      <div className="workspace-context surface-card">
        <div className="workspace-context-project">
          <span className="workspace-context-icon"><TerminalSquare size={17} /></span>
          <span><span className="eyebrow">ACTIVE PROJECT DIRECTORY</span><code title={workspacePath}>{workspacePath}</code></span>
        </div>
        <div className="workspace-context-stats">
          <button onClick={() => onNavigate('runs')}><strong>{activeRuns}</strong><span>Active runs</span></button>
          <button onClick={() => onNavigate('agents')}><strong>{activeAgents}</strong><span>Active subagents</span></button>
        </div>
      </div>
      <section className="overview-banner">
        <div className="banner-orbit orbit-one" /><div className="banner-orbit orbit-two" />
        <div className="banner-copy">
          <h2>{status?.provider ? <>Working with <span>{status.provider.split('/')[0]}</span></> : 'Waiting for your runtime'}</h2>
          <p>{status?.provider ? `Model ${status.provider.split('/').slice(1).join('/') || 'configured'} · ${status.activeTurns ?? 0} active ${status.activeTurns === 1 ? 'turn' : 'turns'}` : 'Start the Symbiote gateway to bring your control room online.'}</p>
          {status && <HeroTaskForm sessionId={activeSessionId} onStart={onStartRun} starting={startingRun} />}
          <button className="banner-link" onClick={() => onNavigate('operations')}>View runtime details <ArrowRight size={15} /></button>
        </div>
        <WorkspaceGraph sessions={sessions} agents={agents} onOpenSession={onOpenSession} onViewAgents={() => onNavigate('agents')} />
        <div className="banner-index">SYS / 01</div>
      </section>

      <section className="metric-grid" aria-label="Runtime summary">
        <MetricCard icon={Server} label="Uptime" tone="neutral">
          <div className="uptime-card-main"><strong className="metric-value">{status?.uptimeHuman || '—'}</strong><StopwatchDial seconds={(status?.uptime ?? 0) / 1000} /></div>
        </MetricCard>
        <MetricCard icon={MessageSquare} label="Conversations" tone="green">
          <strong className="metric-value">{status?.sessions ?? sessions.length}</strong>
          <span className="metric-detail">Saved sessions</span>
        </MetricCard>
        <MetricCard icon={Activity} label="Active turns" tone="orange">
          <strong className="metric-value">{status?.activeTurns ?? '—'}</strong>
          <span className="metric-detail">Running now</span>
        </MetricCard>
        <MemoryInUseCard host={host} processRssMb={memory?.rss} />
      </section>
      <section className="metric-grid system-metric-grid" aria-label="Computer resource usage">
        <MetricCard icon={Cpu} label="Host CPU" tone="orange">
          <div className="metric-reading"><strong className="metric-value">{host?.cpuPercent === null || host?.cpuPercent === undefined ? '—' : `${host.cpuPercent.toFixed(1)}%`}</strong><span>{host ? `${host.cpuLogicalCores} cores` : 'Waiting for sample'}</span></div>
          <MetricPlot label="Host CPU utilization over time" series={[{ name: 'CPU', color: '#c8785e', values: hostHistory.map(sample => sample.cpuPercent ?? 0) }]} maxValue={100} />
        </MetricCard>
        <MetricCard icon={MemoryStick} label="System RAM" tone="blue">
          <div className="metric-memory-reading"><strong>{host ? formatSystemBytes(host.memory.totalBytes - host.memory.freeBytes) : '—'}</strong><span>/ {host ? formatSystemBytes(host.memory.totalBytes) : '—'}</span></div>
          <div className="metric-reading-subtext">{host ? `${host.memory.usedPercent.toFixed(1)}% in use` : 'Waiting for sample'}</div>
          <MetricPlot label="System RAM use over time" area series={[{ name: 'Used', color: '#7396a0', values: hostHistory.map(sample => sample.memory.totalBytes - sample.memory.freeBytes) }]} maxValue={host?.memory.totalBytes || 1} />
        </MetricCard>
        <MetricCard icon={Network} label="Network I/O" tone="green">
          <div className="metric-dual-reading"><span><b>↓</b> {formatRate(host?.network.receiveBytesPerSecond)}</span><span><b>↑</b> {formatRate(host?.network.transmitBytesPerSecond)}</span></div>
          <MetricPlot label="Network receive and transmit rates" series={[
            { name: 'Down', color: '#759b6c', values: hostHistory.map(sample => sample.network.receiveBytesPerSecond ?? 0) },
            { name: 'Up', color: '#c8785e', values: hostHistory.map(sample => sample.network.transmitBytesPerSecond ?? 0) },
          ]} />
        </MetricCard>
        <MetricCard icon={HardDrive} label="Disk I/O" tone="neutral">
          <div className="metric-dual-reading"><span>Read {formatRate(host?.disk.readBytesPerSecond)}</span><span>Write {formatRate(host?.disk.writeBytesPerSecond)}</span></div>
          <MetricPlot label="Disk read and write rates" series={[
            { name: 'Read', color: '#77949d', values: hostHistory.map(sample => sample.disk.readBytesPerSecond ?? 0) },
            { name: 'Write', color: '#c8785e', values: hostHistory.map(sample => sample.disk.writeBytesPerSecond ?? 0) },
          ]} />
        </MetricCard>
      </section>

      <div className="overview-columns">
        <section className="surface-card work-card">
          <div className="section-heading">
            <div><div className="eyebrow">KEEP THE THREAD</div><h2>Recent conversations</h2></div>
            <button className="text-button" onClick={() => onNavigate('sessions')}>All sessions <ArrowUpRight size={14} /></button>
          </div>
          {latestSessions.length ? (
            <div className="conversation-list">
              {latestSessions.map((session, index) => (
                <button className="conversation-row" key={session.id} onClick={() => onOpenSession(session.id)}>
                  <span className={`conversation-avatar avatar-${index % 4}`}>{initials(session.label)}</span>
                  <span className="conversation-copy"><strong>{session.label || 'Untitled conversation'}</strong><small>{session.messageCount} messages <span>·</span> {formatRelative(session.updatedAt)}</small></span>
                  <ArrowRight size={15} className="row-arrow" />
                </button>
              ))}
            </div>
          ) : (
            <EmptyState icon={MessageSquare} title="A clean slate." detail="Start a conversation with the agent; it will be saved to this runtime." action={<button className="button button-secondary" onClick={onNewSession}><Plus size={15} />Start a conversation</button>} />
          )}
        </section>

        <section className="surface-card runtime-card">
          <div className="section-heading">
            <div><div className="eyebrow">UNDER THE HOOD</div><h2>Runtime pulse</h2></div>
            <span className="subtle-label">{lastUpdated ? `UPDATED ${new Date(lastUpdated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'WAITING'}</span>
          </div>
          <div className="runtime-stat">
            <div className="runtime-stat-heading"><span>Process memory</span><strong>{formatBytes(memory?.rss)}</strong></div>
            <Sparkline values={memoryHistory} />
            <div className="runtime-footnote"><span>Resident set size</span><span>Live · 3 second interval</span></div>
          </div>
          <div className="runtime-divider" />
          <div className="runtime-mini-grid">
            <div><span>Sessions stored</span><strong>{status?.sessions ?? sessions.length}</strong></div>
            <div><span>Tools registered</span><strong>{status?.tools ?? '—'}</strong></div>
            <div><span>Turns recorded</span><strong>{metrics?.totalTurns ?? metrics?.turns ?? '—'}</strong></div>
            <div><span>Node process</span><strong>{status?.pid ? `PID ${status.pid}` : '—'}</strong></div>
          </div>
          <div className="runtime-divider" />
          <div className="runtime-thermal-row">
            <div className="runtime-thermal-icon"><Thermometer size={15} /></div>
            <div className="runtime-thermal-copy">
              <strong>{temperatureSensor ? `${temperatureSensor.name} · ${temperatureSensor.celsius.toFixed(1)}°C` : 'Temperature unavailable'}</strong>
              <small title={host?.temperature.source}>{temperatureSensor?.source ?? 'No readable temperature sensor exposed by this device'}</small>
            </div>
          </div>
          <div className={`runtime-alert-panel${activeResourceAlerts.length ? ' runtime-alert-active' : ''}`} aria-live="polite">
            <div className="runtime-alert-heading"><CircleAlert size={13} /><strong>{activeResourceAlerts.length ? `${activeResourceAlerts.length} active resource alert${activeResourceAlerts.length === 1 ? '' : 's'}` : 'No active resource alerts'}</strong></div>
            {activeResourceAlerts.length
              ? <ul>{activeResourceAlerts.map(alert => <li key={alert.id}>{alert.label}</li>)}</ul>
              : <small>CPU and RAM alerts at 85% · sensor alerts at 85°C. Critical at 95.</small>}
            {host?.warnings.map((warning, index) => <small className="runtime-warning" key={`${index}-${warning}`}>{warning}</small>)}
          </div>
        </section>
      </div>

      <section className="surface-card channel-card">
        <div className="section-heading">
          <div><div className="eyebrow">CONNECTED SURFACES</div><h2>Channels</h2></div>
          <button className="text-button" onClick={() => onNavigate('operations')}>Operations <ArrowUpRight size={14} /></button>
        </div>
        {channels.length ? (
          <div className="channel-grid">
            {channels.map(channel => <ChannelTile key={channel.id} channel={channel} />)}
          </div>
        ) : (
          <div className="inline-empty"><span className="empty-icon"><Network size={18} /></span><div><strong>No channel adapters registered</strong><p>Connect a channel in your Symbiote configuration to see its live health here.</p></div></div>
        )}
      </section>
      <div className="page-footnote"><span>{status?.pid ? `PROCESS ${status.pid}` : 'RUNTIME NOT CONNECTED'}</span></div>
    </div>
  );
}

const TASK_PROMPTS = [
  'Need something done?', 'How can I help?', 'What should we work on?', 'What would you like me to handle?',
  'What can I take off your plate?', 'What needs your attention?', 'Where should we begin?', 'What would move this forward?',
  'What should I look into?', 'What would you like to improve?', 'What needs building?', 'What can I help you solve?',
  'Have a task in mind?', 'What should I take care of?', 'What would you like to explore?', 'What needs a closer look?',
  'What should I investigate?', 'What would you like to change?', 'What is the next priority?', 'What should I review?',
  'What would you like to ship?', 'What can I make simpler?', 'What is getting in the way?', 'What should I work through?',
  'What needs a second set of eyes?', 'What should I prototype?', 'What do you want to understand?', 'What should I organize?',
  'What would you like me to prepare?', 'What should I verify?', 'What needs to be documented?', 'What should I test?',
  'What should I trace?', 'What would you like to automate?', 'What is the rough edge?', 'What should I untangle?',
  'What is worth fixing first?', 'What can I clarify?', 'What should I compare?', 'What would you like to plan?',
  'What should I map out?', 'What needs a careful read?', 'What should I validate?', 'What can I refine?',
  'What is the current challenge?', 'What should I follow up on?', 'What would you like to make clearer?',
  'What should I inspect?', 'What should I draft?', 'What deserves a deeper look?', 'What can I help move along?',
  'What would you like to get unstuck?', 'What should I check for you?', 'What can I build around this?',
  'What should I break down?', 'What is the next small step?', 'What can I help finish?', 'What should I clean up?',
  'What would you like to make reliable?', 'What should I connect?', 'What should I try?', 'What is still unclear?',
  'What needs to work better?', 'What should I search for?', 'What can I help you decide?', 'What should I improve first?',
  'What should I look after?', 'What would you like to ship next?', 'What can I help prepare?', 'What needs to be checked?',
  'What should I make easier?', 'What can I help maintain?', 'What would you like to get ready?', 'What should I reason through?',
  'What is the key question?', 'What should I evaluate?', 'What would you like me to find?', 'What needs a clear answer?',
  'What should I make consistent?', 'What needs a safer approach?', 'What should I compare closely?', 'What can I help unblock?',
  'What would you like to get done today?', 'What should I focus on?', 'What needs to be ready?', 'What should I investigate next?',
  'What is the best place to start?', 'What would you like me to check?', 'What should I sort out?', 'What should I make work?',
  'What needs to be more dependable?', 'What should I trace through?', 'What can I help you understand?', 'What would you like to refine?',
  'What can I take from here?', 'What should we tackle next?', 'What do you need from me?', 'What is on your mind?',
  'What would make today easier?', 'What shall we figure out together?',
];

const TASK_HELP = 'Launch an agent run in this project. The agent can delegate independent work to subagents.';

function HeroTaskForm({ sessionId, onStart, starting }: {
  sessionId: string;
  onStart: (prompt: string, sessionId: string) => Promise<boolean>;
  starting: boolean;
}) {
  const [prompt, setPrompt] = useState('');
  const [heading] = useState(() => TASK_PROMPTS[Math.floor(Math.random() * TASK_PROMPTS.length)]);
  return (
    <form className="hero-task" onSubmit={event => {
      event.preventDefault();
      if (prompt.trim()) {
        void onStart(prompt.trim(), sessionId).then(started => {
          if (started) {
            setPrompt('');
            const textarea = document.getElementById('hero-task-prompt') as HTMLTextAreaElement | null;
            if (textarea) textarea.style.height = 'auto';
          }
        });
      }
    }}>
      <div className="hero-task-heading">
        <h3>{heading}</h3>
        <span className="task-help">
          <button type="button" aria-label="Task help" aria-describedby="task-help-text"><Info size={14} /></button>
          <span id="task-help-text" role="tooltip">{TASK_HELP}</span>
        </span>
      </div>
      <div className="hero-task-fields">
        <label className="sr-only" htmlFor="hero-task-prompt">Task instructions</label>
        <textarea id="hero-task-prompt" required value={prompt} onChange={event => {
          setPrompt(event.target.value);
          event.currentTarget.style.height = 'auto';
          event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 260)}px`;
        }} maxLength={20_000} rows={1} placeholder="Describe the task…" />
        <button type="submit" className="hero-task-submit" aria-label={starting ? 'Starting task' : 'Start task'} title={starting ? 'Starting task' : 'Start task'} disabled={starting || !prompt.trim()}>
          {starting ? <LoaderCircle size={15} className="spin" /> : <ArrowRight size={15} />}
        </button>
      </div>
    </form>
  );
}

interface GraphNode {
  id: string;
  label: string;
  kind: 'main' | 'conversation' | 'agent';
  parentId?: string;
  sessionId?: string;
  status?: WorkspaceAgent['status'];
}

interface GraphPoint { x: number; y: number; vx: number; vy: number; }

function WorkspaceGraph({ sessions, agents, onOpenSession, onViewAgents }: {
  sessions: SessionSummary[];
  agents: WorkspaceAgent[];
  onOpenSession: (id: string) => void;
  onViewAgents: () => void;
}) {
  const nodes = useMemo<GraphNode[]>(() => {
    const conversations = sessions.filter(session =>
      session.sessionKind === 'conversation' || (session.id.startsWith('web-') && !session.id.startsWith('web-run-')),
    );
    const conversationIds = new Set(conversations.map(session => session.id));
    return [
      { id: 'main', label: 'Main agent', kind: 'main' },
      ...conversations.map(session => ({
        id: session.id,
        sessionId: session.id,
        label: session.label || 'Conversation',
        kind: 'conversation' as const,
        parentId: 'main',
      })),
      ...agents.map(agent => ({
        id: agent.sessionId,
        sessionId: agent.sessionId,
        label: agent.task,
        kind: 'agent' as const,
        parentId: conversationIds.has(agent.parentSessionId ?? '') ? agent.parentSessionId : 'main',
        status: agent.status,
      })),
    ];
  }, [sessions, agents]);
  const [points, setPoints] = useState<Record<string, GraphPoint>>({});
  const pointsRef = useRef(points);
  pointsRef.current = points;

  useEffect(() => {
    const next = { ...pointsRef.current };
    const center = { x: 180, y: 130 };
    for (const [index, node] of nodes.entries()) {
      if (node.kind === 'main') {
        next[node.id] = { ...center, vx: 0, vy: 0 };
        continue;
      }
      if (next[node.id]) continue;
      let hash = 0;
      for (const char of node.id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
      const angle = (Math.abs(hash) % 360) * Math.PI / 180 + index * .41;
      const radius = node.kind === 'agent' ? 116 : 84;
      next[node.id] = {
        x: center.x + Math.cos(angle) * radius,
        y: center.y + Math.sin(angle) * radius * .72,
        vx: Math.sin(angle) * .3,
        vy: -Math.cos(angle) * .3,
      };
    }
    const activeIds = new Set(nodes.map(node => node.id));
    for (const id of Object.keys(next)) if (!activeIds.has(id)) delete next[id];
    pointsRef.current = next;
    setPoints(next);
  }, [nodes]);

  useEffect(() => {
    let frame = 0;
    let tick = 0;
    const animate = () => {
      const current = pointsRef.current;
      const next = { ...current };
      const dynamic = nodes.filter(node => node.kind !== 'main');
      for (const node of dynamic) {
        const point = next[node.id];
        if (!point) continue;
        let fx = 0;
        let fy = 0;
        const centerX = point.x - 180;
        const centerY = point.y - 130;
        const radius = Math.max(1, Math.hypot(centerX, centerY));
        const desiredRadius = node.kind === 'agent' ? 114 : 78;
        const radial = (desiredRadius - radius) * .0012;
        fx += centerX / radius * radial;
        fy += centerY / radius * radial;
        for (const other of dynamic) {
          if (other.id === node.id) continue;
          const target = next[other.id];
          if (!target) continue;
          const dx = point.x - target.x;
          const dy = point.y - target.y;
          const distanceSquared = Math.max(100, dx * dx + dy * dy);
          fx += dx / distanceSquared * 2.2;
          fy += dy / distanceSquared * 2.2;
        }
        const parent = node.parentId && next[node.parentId];
        if (parent) {
          const dx = parent.x - point.x;
          const dy = parent.y - point.y;
          const distance = Math.max(1, Math.hypot(dx, dy));
          const targetDistance = node.kind === 'agent' ? 42 : 82;
          const spring = (distance - targetDistance) * .00075;
          fx += dx / distance * spring;
          fy += dy / distance * spring;
        }
        point.vx = (point.vx + fx) * .985;
        point.vy = (point.vy + fy) * .985;
        point.x = Math.min(340, Math.max(20, point.x + point.vx));
        point.y = Math.min(248, Math.max(16, point.y + point.vy));
      }
      tick++;
      if (tick % 2 === 0) {
        pointsRef.current = next;
        setPoints({ ...next });
      }
      frame = window.requestAnimationFrame(animate);
    };
    frame = window.requestAnimationFrame(animate);
    return () => window.cancelAnimationFrame(frame);
  }, [nodes]);

  return (
    <svg className="banner-illustration workspace-graph" viewBox="0 0 360 260" role="group" aria-label="Live workspace graph. Select a conversation or subagent to open it.">
      <defs>
        <radialGradient id="agent-glow"><stop stopColor="#c8d98d" stopOpacity=".3" /><stop offset="1" stopColor="#c8d98d" stopOpacity="0" /></radialGradient>
      </defs>
      {nodes.filter(node => node.parentId).map(node => {
        const child = points[node.id];
        const parent = node.parentId === 'main' ? { x: 180, y: 130 } : points[node.parentId!];
        if (!child || !parent) return null;
        return <line key={`link-${node.id}`} className={`graph-link graph-link-${node.kind}`} x1={parent.x} y1={parent.y} x2={child.x} y2={child.y} />;
      })}
      {nodes.map(node => {
        const point = node.kind === 'main' ? { x: 180, y: 130 } : points[node.id];
        if (!point) return null;
        if (node.kind === 'main') return (
          <g key={node.id} className="graph-main-node">
            <circle cx={point.x} cy={point.y} r="36" fill="url(#agent-glow)" />
            <circle className="graph-core-ring" cx={point.x} cy={point.y} r="18" />
            <circle className="graph-core" cx={point.x} cy={point.y} r="7" />
          </g>
        );
        const conversation = node.kind === 'conversation';
        return (
          <g
            key={node.id}
            className={`graph-node graph-node-${node.kind}${node.status === 'running' ? ' graph-node-active' : ''}`}
            role="button"
            tabIndex={0}
            aria-label={`${conversation ? 'Open conversation' : 'View subagent'}: ${node.label}`}
            onClick={() => conversation ? onOpenSession(node.sessionId!) : onViewAgents()}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                conversation ? onOpenSession(node.sessionId!) : onViewAgents();
              }
            }}
          >
            <title>{node.label}</title>
            <circle cx={point.x} cy={point.y} r={conversation ? 5.5 : 4} />
          </g>
        );
      })}
    </svg>
  );
}

function RunStatus({ status }: { status: WorkspaceRun['status'] }) {
  const Icon = status === 'running' ? Clock3 : status === 'completed' ? CircleCheck : CircleAlert;
  return <span className={`run-status run-status-${status}`}><Icon size={13} />{status}</span>;
}

function RunsView({ runs, agents, onStop, onRestart, onGuide, onOpenSession }: {
  runs: WorkspaceRun[];
  agents: WorkspaceAgent[];
  onStop: (id: string) => void;
  onRestart: (id: string) => void;
  onGuide: (id: string, message: string) => Promise<void>;
  onOpenSession: (sessionId: string) => void;
}) {
  const lanes: Array<{ key: string; title: string; description: string; items: WorkspaceRun[] }> = [
    { key: 'active', title: 'In progress', description: 'The main agent is working', items: runs.filter(run => run.status === 'running') },
    { key: 'done', title: 'Completed', description: 'Finished task runs', items: runs.filter(run => run.status === 'completed') },
    { key: 'attention', title: 'Needs attention', description: 'Stopped or failed runs', items: runs.filter(run => run.status === 'failed' || run.status === 'cancelled') },
  ];
  return (
    <div className="page task-page">
      <PageHeading eyebrow="AGENTIC WORKFLOW" title="Task board" detail="Track the main agent’s work, send guidance, stop a run, or restart from its saved conversation." />
      <div className="task-board" aria-label="Agentic task board">
        {lanes.map(lane => (
          <section className={`task-lane task-lane-${lane.key}`} key={lane.key} aria-label={`${lane.title} tasks`}>
            <header className="task-lane-heading">
              <div><h2>{lane.title}</h2><p>{lane.description}</p></div>
              <span>{lane.items.length}</span>
            </header>
            {lane.items.length ? lane.items.map(run => {
              const runAgents = agents.filter(agent => agent.parentSessionId === run.sessionId);
              return <TaskCard key={run.id} run={run} runAgents={runAgents} onStop={onStop} onRestart={onRestart} onGuide={onGuide} onOpenSession={onOpenSession} />;
            }) : <div className="task-lane-empty">No tasks here</div>}
          </section>
        ))}
      </div>
    </div>
  );
}

function TaskCard({ run, runAgents, onStop, onRestart, onGuide, onOpenSession }: {
  run: WorkspaceRun;
  runAgents: WorkspaceAgent[];
  onStop: (id: string) => void;
  onRestart: (id: string) => void;
  onGuide: (id: string, message: string) => Promise<void>;
  onOpenSession: (sessionId: string) => void;
}) {
  const [guidance, setGuidance] = useState('');
  const [sendingGuidance, setSendingGuidance] = useState(false);
  const sendGuidance = async (message: string) => {
    if (!message.trim()) return;
    setSendingGuidance(true);
    try {
      await onGuide(run.id, message.trim());
      setGuidance('');
    } finally {
      setSendingGuidance(false);
    }
  };
  return (
    <article className="task-card">
      <div className="task-card-heading"><div><h3>{run.name}</h3><span className="run-meta">{formatRelative(run.startedAt)} · {formatElapsed(run.startedAt, run.completedAt)}</span></div><RunStatus status={run.status} /></div>
      <details className="run-prompt"><summary>Task brief</summary><p>{run.prompt}</p></details>
      {!!runAgents.length && <div className="run-tool-summary"><Users size={13} />{runAgents.filter(agent => agent.status === 'running').length} active of {runAgents.length} agents</div>}
      {run.error && <p className="run-result run-error"><CircleAlert size={14} />{run.error}</p>}
      {run.result && <div className="run-result"><strong>Agent result</strong><MessageBody content={run.result} /></div>}
      {!!run.toolNames?.length && <div className="run-tool-summary"><Wrench size={13} />{run.toolNames.join(', ')}</div>}
      {run.status === 'running' && <form className="task-guidance-form" onSubmit={event => { event.preventDefault(); void sendGuidance(guidance); }}>
        <textarea value={guidance} onChange={event => setGuidance(event.target.value)} maxLength={2_000} rows={2} placeholder="Guide or nudge the agent…" aria-label={`Guide task ${run.name}`} />
        <button type="submit" className="button button-secondary" disabled={sendingGuidance || !guidance.trim()}>{sendingGuidance ? <LoaderCircle size={14} className="spin" /> : <ArrowRight size={14} />}Guide</button>
      </form>}
      <div className="task-card-actions">
        <button className="button button-secondary" onClick={() => onOpenSession(run.sessionId)}><MessageSquare size={14} />Conversation</button>
        {run.status === 'running'
          ? <button className="button button-danger" onClick={() => onStop(run.id)}><X size={14} />Kill run</button>
          : <>
            {(run.status === 'cancelled' || run.status === 'failed') && <button className="button button-secondary" onClick={() => void sendGuidance('Continue this task from the existing conversation. Check what remains and complete the work.')}>Nudge</button>}
            <button className="button button-secondary" onClick={() => onRestart(run.id)}><RefreshCw size={14} />Restart</button>
          </>}
      </div>
    </article>
  );
}

function AgentsView({ agents, onControl }: {
  agents: WorkspaceAgent[];
  onControl: (id: string, action: 'stop' | 'steer', message?: string) => Promise<void>;
}) {
  return (
    <div className="page">
      <PageHeading eyebrow="PARALLEL WORKERS" title="Agents" detail="Observe and control subagents spawned by the Symbiote runtime." />
      <div className="agent-capability-note"><Users size={16} /><span>Subagents run in isolated sessions under the gateway’s existing tool sandbox. Steering sends guidance; stop cancels an active agent.</span></div>
      {agents.length ? <section className="agent-list">{agents.slice().sort((a, b) => b.startedAt - a.startedAt).map(agent => <AgentCard key={agent.sessionId} agent={agent} onControl={onControl} />)}</section> : (
        <section className="surface-card"><EmptyState icon={Users} title="No subagents yet" detail="When a task delegates work using Symbiote’s spawn tool, its subagent will appear here." /></section>
      )}
    </div>
  );
}

function AgentCard({ agent, onControl }: {
  agent: WorkspaceAgent;
  onControl: (id: string, action: 'stop' | 'steer', message?: string) => Promise<void>;
}) {
  const [steering, setSteering] = useState('');
  const isRunning = agent.status === 'running';
  return (
    <article className="surface-card agent-card">
      <div className="run-card-heading"><div><h3>{agent.task}</h3><span className="run-meta">Agent {agent.sessionId} · {formatElapsed(agent.startedAt, agent.completedAt)}</span></div><span className={`run-status run-status-${agent.status === 'completed' ? 'completed' : agent.status === 'running' ? 'running' : 'failed'}`}>{agent.status}</span></div>
      {agent.parentSessionId && <div className="agent-parent">Parent session <code>{agent.parentSessionId}</code></div>}
      {agent.error && <p className="run-result run-error"><CircleAlert size={14} />{agent.error}</p>}
      {agent.result && <div className="run-result"><strong>Result</strong><p>{agent.result}</p></div>}
      {isRunning && <form className="agent-steer-form" onSubmit={event => {
        event.preventDefault();
        if (!steering.trim()) return;
        void onControl(agent.sessionId, 'steer', steering.trim());
        setSteering('');
      }}><input value={steering} onChange={event => setSteering(event.target.value)} maxLength={2_000} placeholder="Send steering guidance…" aria-label={`Steer ${agent.sessionId}`} /><button className="button button-secondary" type="submit" disabled={!steering.trim()}>Steer</button><button className="button button-danger" type="button" onClick={() => void onControl(agent.sessionId, 'stop')}>Stop</button></form>}
    </article>
  );
}

function MetricCard({ icon: Icon, label, tone, children }: {
  icon: typeof Activity;
  label: string;
  tone: 'neutral' | 'green' | 'orange' | 'blue';
  children: ReactNode;
}) {
  return (
    <div className="metric-card">
      <div className="metric-card-top"><span className={`metric-icon metric-${tone}`}><Icon size={16} strokeWidth={1.8} /></span><span className="metric-label">{label}</span></div>
      <div className="metric-card-content">{children}</div>
    </div>
  );
}

function StopwatchDial({ seconds }: { seconds: number }) {
  const [clock, setClock] = useState({ seconds, syncedAt: Date.now(), now: Date.now() });
  useEffect(() => {
    const syncedAt = Date.now();
    setClock(current => ({ ...current, seconds, syncedAt }));
  }, [seconds]);
  useEffect(() => {
    const timer = window.setInterval(() => setClock(current => ({ ...current, now: Date.now() })), 100);
    return () => window.clearInterval(timer);
  }, []);
  const elapsed = Math.max(0, clock.seconds + (clock.now - clock.syncedAt) / 1000);
  const secondAngle = (elapsed % 60) * 6;
  const minuteAngle = (elapsed / 60 % 60) * 6;
  const hourAngle = (elapsed / 3600 % 12) * 30;
  return (
    <svg className="uptime-stopwatch" viewBox="0 0 84 84" role="img" aria-label={`Live uptime stopwatch, ${Math.floor(elapsed / 3600)} hours, ${Math.floor(elapsed / 60) % 60} minutes, ${Math.floor(elapsed) % 60} seconds`}>
      <circle cx="42" cy="44" r="31" className="stopwatch-face" />
      {Array.from({ length: 12 }, (_, index) => <line key={index} x1="42" y1="16" x2="42" y2="20" className="stopwatch-tick" transform={`rotate(${index * 30} 42 44)`} />)}
      <line x1="42" y1="44" x2="42" y2="30" className="stopwatch-hour-hand" transform={`rotate(${hourAngle} 42 44)`} />
      <line x1="42" y1="44" x2="42" y2="23" className="stopwatch-minute-hand" transform={`rotate(${minuteAngle} 42 44)`} />
      <line x1="42" y1="44" x2="42" y2="19" className="stopwatch-second-hand" transform={`rotate(${secondAngle} 42 44)`} />
      <circle cx="42" cy="44" r="2.5" className="stopwatch-pin" />
      <path d="M35 9h14M42 9v4M58 18l4-4" className="stopwatch-crown" />
    </svg>
  );
}

function WorkspaceClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 250);
    return () => window.clearInterval(timer);
  }, []);
  const time = now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const date = now.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const zone = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(now).find(part => part.type === 'timeZoneName')?.value;
  return (
    <span className="workspace-clock">
      <Clock3 size={14} aria-hidden="true" />
      <time dateTime={now.toISOString()} className="workspace-clock-time">{time}</time>
      <span className="workspace-clock-date">{date}</span>
      {zone && <span className="workspace-clock-zone">{zone}</span>}
    </span>
  );
}

function MemoryInUseCard({ host, processRssMb }: { host?: HostResourceSnapshot; processRssMb?: number }) {
  const total = Math.max(0, host?.memory.totalBytes ?? 0);
  const used = Math.min(total, Math.max(0, total - (host?.memory.freeBytes ?? 0)));
  const process = Math.min(used, Math.max(0, (processRssMb ?? 0) * 1024 * 1024));
  const other = Math.max(0, used - process);
  const available = Math.max(0, total - used);
  const circumference = 2 * Math.PI * 22;
  const segments = [
    { name: 'Symbiote', value: process, color: '#789771' },
    { name: 'Other used', value: other, color: '#d18a68' },
    { name: 'Available', value: available, color: '#c9cabe' },
  ];
  let offset = 0;
  return (
    <MetricCard icon={HardDrive} label="Memory in use" tone="blue">
      <div className="memory-card-content">
        <svg className="memory-donut" viewBox="0 0 56 56" role="img" aria-label={`Memory allocation: ${formatSystemBytes(used)} used of ${formatSystemBytes(total)}`}>
          <circle cx="28" cy="28" r="22" className="memory-donut-track" />
          {total > 0 && segments.map(segment => {
            const length = circumference * segment.value / total;
            const currentOffset = offset;
            offset += length;
            return <circle key={segment.name} cx="28" cy="28" r="22" fill="none" stroke={segment.color} strokeWidth="7" strokeDasharray={`${length} ${circumference - length}`} strokeDashoffset={-currentOffset} transform="rotate(-90 28 28)" />;
          })}
        </svg>
        <div className="memory-card-values">
          <div className="memory-total"><strong>{host ? formatSystemBytes(used) : '—'}</strong><span>/ {host ? formatSystemBytes(total) : '—'}</span></div>
          <div className="memory-card-legend">{segments.map(segment => <span key={segment.name}><i style={{ background: segment.color }} />{segment.name} <b>{host ? formatSystemBytes(segment.value) : '—'}</b></span>)}</div>
        </div>
      </div>
    </MetricCard>
  );
}

function MetricPlot({ series, maxValue, area, label }: {
  series: Array<{ name: string; color: string; values: number[] }>;
  maxValue?: number;
  area?: boolean;
  label: string;
}) {
  const width = 240;
  const height = 48;
  const values = series.flatMap(item => item.values.slice(-60)).filter(Number.isFinite);
  const maximum = Math.max(1, maxValue ?? Math.max(0, ...values) * 1.1);
  const pathFor = (samples: number[], closeArea = false) => {
    const points = samples.slice(-60).map((value, index, all) => {
      const x = all.length < 2 ? width : index / (all.length - 1) * width;
      const y = height - Math.max(0, Math.min(1, value / maximum)) * (height - 4) - 2;
      return [x, y] as const;
    });
    if (!points.length) return '';
    const path = `M ${points.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(' L ')}`;
    return closeArea ? `${path} L ${points[points.length - 1][0].toFixed(1)} ${height} L ${points[0][0].toFixed(1)} ${height} Z` : path;
  };
  return (
    <div className="metric-plot">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={label}>
        {[12, 24, 36].map(y => <line key={y} x1="0" y1={y} x2={width} y2={y} className="metric-plot-grid" />)}
        {series.map((item, index) => <g key={item.name}>
          {area && index === 0 && <path d={pathFor(item.values, true)} fill={item.color} fillOpacity=".15" />}
          <path d={pathFor(item.values)} fill="none" stroke={item.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        </g>)}
      </svg>
      {series.length > 1 && <div className="metric-plot-legend">{series.map(item => <span key={item.name}><i style={{ background: item.color }} />{item.name}</span>)}</div>}
    </div>
  );
}

function ChannelTile({ channel }: { channel: GatewayStatus['channels'][number] }) {
  const online = channel.status === 'running' || channel.health?.state === 'connected';
  return (
    <div className="channel-tile">
      <span className={`channel-symbol${online ? ' channel-symbol-live' : ''}`}>{channel.channelType.slice(0, 1).toUpperCase()}</span>
      <span className="channel-copy"><strong>{channel.id}</strong><small>{channel.channelType}</small></span>
      <span className={`status-tag${online ? ' status-tag-live' : ' status-tag-idle'}`}><span />{online ? 'Connected' : channel.status || 'Offline'}</span>
    </div>
  );
}

function ChatView(props: {
  session?: SessionSummary;
  sessions: SessionSummary[];
  messages: ChatMessage[];
  draft: string;
  sending: boolean;
  onDraft: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onStop: () => void;
  onNewSession: () => void;
  onSelectSession: (id: string) => void;
  onArchiveSession: (id: string) => Promise<void>;
  bottomRef: RefObject<HTMLDivElement | null>;
  creatingSession: boolean;
}) {
  const { session, sessions, messages, draft, sending, onDraft, onSubmit, onStop, onNewSession, onSelectSession, onArchiveSession, bottomRef, creatingSession } = props;
  const exportSession = () => {
    const transcript = [
      `# ${session?.label || 'Symbiote conversation'}`,
      '',
      `Exported ${new Date().toLocaleString()}`,
      '',
      ...messages.flatMap(message => [
        `## ${message.role === 'assistant' ? 'Symbiote' : 'You'}`,
        message.timestamp ? `_${new Date(message.timestamp).toLocaleString()}_` : '',
        '',
        message.content,
        '',
      ]),
    ].join('\n');
    const url = URL.createObjectURL(new Blob([transcript], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${(session?.label || 'symbiote-conversation').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').slice(0, 80)}.md`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="page page-chat">
      <PageHeading
        eyebrow="A DIRECT LINE TO YOUR AGENT"
        title={session?.label || 'Conversations'}
        detail={session ? `${session.messageCount} saved messages · Updated ${formatRelative(session.updatedAt)}` : 'Choose a saved session, or start a new conversation.'}
        action={<div className="chat-session-actions">
          <label className="sr-only" htmlFor="session-picker">Select conversation</label>
          <select id="session-picker" className="session-picker" value={session?.id || ''} onChange={event => onSelectSession(event.target.value)}>
            {!sessions.length && <option value="">No saved sessions</option>}
            {sessions.map(item => <option key={item.id} value={item.id}>{item.label || item.id}</option>)}
          </select>
          <button className="button button-secondary export-button" onClick={exportSession} disabled={!session || !messages.length} title="Download this conversation as Markdown"><Download size={15} /><span className="button-label">Export</span></button>
          <button className="button button-secondary" onClick={() => session && void onArchiveSession(session.id)} disabled={!session} title="Move this conversation to the archive"><Archive size={15} /><span className="button-label">Archive</span></button>
          <button className="button button-primary" onClick={onNewSession} disabled={creatingSession}><Plus size={16} /><span className="button-label">New</span></button>
        </div>}
      />
      <section className="chat-shell" aria-label="Conversation">
        <div className="chat-stream" aria-live="polite" aria-relevant="additions text">
          {messages.length ? messages.map(message => (
            <article key={message.id} className={`message-row message-${message.role}`}>
              <div className={`message-avatar${message.role === 'assistant' ? ' message-avatar-agent' : ''}`} aria-hidden="true">{message.role === 'assistant' ? <Bot size={17} /> : 'A'}</div>
              <div className="message-main">
                <div className="message-meta"><strong>{message.role === 'assistant' ? configLabel() : 'You'}</strong><span>{message.timestamp ? formatRelative(message.timestamp) : ''}</span>{message.role === 'assistant' && message.iterations !== undefined && <span>{message.iterations} {message.iterations === 1 ? 'step' : 'steps'}</span>}</div>
                {message.content && <MessageBody content={message.content} />}
                {message.interrupted && <div className="message-interrupted" role="status">This reply did not finish. Your message is preserved; you can try again.</div>}
                {!!message.toolCalls?.length && (
                  <details className="tool-activity">
                    <summary><Wrench size={14} />{message.toolCalls.length} {message.toolCalls.length === 1 ? 'tool action' : 'tool actions'}<ChevronDown size={14} /></summary>
                    <div className="tool-activity-list">{message.toolCalls.map((call, index) => <div key={`${call.name}-${index}`}><code>{call.name}</code><span>{call.result.slice(0, 280) || 'Completed'}</span></div>)}</div>
                  </details>
                )}
                {message.streaming && (message.thinking || message.activeTools?.length) && <div className="message-live-activity" aria-live="polite">
                  <span className="thinking-pulse" />
                  {message.activeTools?.length ? `Using ${message.activeTools.join(', ')}` : 'Thinking'}
                </div>}
              </div>
            </article>
          )) : (
            <div className="chat-welcome">
              <span className="welcome-mark"><Sparkles size={20} /></span>
              <div className="eyebrow">YOUR SYMBIOTE, READY WHEN YOU ARE</div>
              <h2>What are we working on?</h2>
              <p>Ask a question, explore an idea, or give your agent a task. Responses and tool activity are saved to this session.</p>
              <div className="prompt-suggestions">
                <button onClick={() => onDraft('Give me a concise overview of this Symbiote runtime.')}>“Give me a runtime overview.” <ArrowUpRight size={13} /></button>
                <button onClick={() => onDraft('What tools are available to you in this session?')}>“What can you help me with?” <ArrowUpRight size={13} /></button>
              </div>
            </div>
          )}
          {sending && <div className="thinking-row"><span className="thinking-pulse" /><span>Agent is working</span></div>}
          <div ref={bottomRef} />
        </div>
        <form className="composer" onSubmit={onSubmit}>
          <label className="sr-only" htmlFor="message-composer">Message your agent</label>
          <textarea
            id="message-composer"
            value={draft}
            onChange={event => onDraft(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder={session ? 'Message your agent…' : 'Select or create a conversation to begin…'}
            rows={2}
            disabled={!session}
          />
          <div className="composer-bottom">
            <span><Command size={12} /> Enter to send <span className="composer-divider">·</span> Shift + Enter for a new line</span>
            {sending
              ? <div className="composer-run-actions">
                <button className="button button-secondary hold-button" type="button" onClick={onStop}><CircleAlert size={14} />Hold on</button>
                <button className="send-button stop-button" type="button" onClick={onStop} aria-label="Stop agent turn" title="Stop agent turn"><X size={16} /><span>Stop</span></button>
              </div>
              : <button className="send-button" type="submit" disabled={!draft.trim() || !session} aria-label="Send message"><Send size={16} /><span>Send</span></button>}
          </div>
        </form>
        <div className="chat-assurance"><ShieldCheck size={13} /> Messages stay in your local Symbiote session store.</div>
      </section>
    </div>
  );
}

interface BrowserFrame {
  url: string;
  title: string;
  viewport: { width: number; height: number };
  image: string;
}

function BrowserView() {
  const [frame, setFrame] = useState<BrowserFrame | null>(null);
  const [address, setAddress] = useState('');
  const [inputText, setInputText] = useState('');
  const [key, setKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const lastMoveAt = useRef(0);
  const imageRef = useRef<HTMLImageElement>(null);
  const currentFrame = useRef<BrowserFrame | null>(null);
  currentFrame.current = frame;

  const capture = useCallback(async () => {
    const next = await api<BrowserFrame>('/api/browser/snapshot');
    setFrame(next);
    setAddress(next.url);
    setError('');
  }, []);

  useEffect(() => {
    void capture().catch(failure => setError(failure instanceof Error ? failure.message : 'Browser is not available.'));
    const timer = window.setInterval(() => void capture().catch(failure => setError(failure instanceof Error ? failure.message : 'Could not refresh browser.')), 5000);
    return () => window.clearInterval(timer);
  }, [capture]);

  const navigateTo = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!address.trim() || loading) return;
    setLoading(true);
    setError('');
    try {
      const next = await api<Pick<BrowserFrame, 'url' | 'title'>>('/api/browser/navigate', {
        method: 'POST',
        body: JSON.stringify({ url: address.trim() }),
      });
      setAddress(next.url);
      await capture();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Browser navigation failed.');
    } finally {
      setLoading(false);
    }
  };

  const act = async (action: string, values: Record<string, unknown>) => {
    if (loading) return;
    setLoading(true);
    setError('');
    try {
      const next = await api<BrowserFrame>('/api/browser/action', {
        method: 'POST',
        body: JSON.stringify({ action, ...values }),
      });
      setFrame(next);
      setAddress(next.url);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Browser action failed.');
    } finally {
      setLoading(false);
    }
  };

  const viewportPoint = (event: ReactMouseEvent<HTMLImageElement>) => {
    const activeFrame = currentFrame.current;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!activeFrame || bounds.width === 0 || bounds.height === 0) return null;
    return {
      x: (event.clientX - bounds.left) * activeFrame.viewport.width / bounds.width,
      y: (event.clientY - bounds.top) * activeFrame.viewport.height / bounds.height,
    };
  };

  useEffect(() => {
    const image = imageRef.current;
    if (!image) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const activeFrame = currentFrame.current;
      const bounds = image.getBoundingClientRect();
      if (!activeFrame || bounds.width === 0 || bounds.height === 0) return;
      void act('scroll', {
        x: (event.clientX - bounds.left) * activeFrame.viewport.width / bounds.width,
        y: (event.clientY - bounds.top) * activeFrame.viewport.height / bounds.height,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
      });
    };
    image.addEventListener('wheel', onWheel, { passive: false });
    return () => image.removeEventListener('wheel', onWheel);
  }, [frame, loading]);

  return (
    <div className="page browser-page">
      <PageHeading eyebrow="PLAYWRIGHT BROWSER" title="Browser" detail="A persistent Chromium session controlled with the same mouse, keyboard, and scroll actions as the agent." />
      <section className="browser-shell" aria-label="Interactive browser">
        <form className="browser-address-bar" onSubmit={event => void navigateTo(event)}>
          <span className="browser-lock"><Globe size={15} /></span>
          <label className="sr-only" htmlFor="browser-address">Navigate to website</label>
          <input id="browser-address" value={address} onChange={event => setAddress(event.target.value)} placeholder="Enter a website address" autoComplete="url" />
          <button className="icon-button" type="submit" disabled={loading || !address.trim()} aria-label="Go to address" title="Go">{loading ? <LoaderCircle size={15} className="spin" /> : <ArrowRight size={16} />}</button>
        </form>
        <div className="browser-titlebar"><span className="browser-status-dot" /><strong>{frame?.title || 'Browser session'}</strong><span>{frame?.viewport ? `${frame.viewport.width} × ${frame.viewport.height}` : ''}</span><button className="icon-button small" onClick={() => void capture().catch(failure => setError(failure instanceof Error ? failure.message : 'Could not capture the page.'))} aria-label="Refresh screenshot" title="Refresh"><RefreshCw size={14} /></button></div>
        {error && <div className="browser-error" role="alert"><span>{error}</span><button className="button button-secondary" onClick={() => { setAddress('https://example.com'); void api<Pick<BrowserFrame, 'url' | 'title'>>('/api/browser/navigate', { method: 'POST', body: JSON.stringify({ url: 'https://example.com' }) }).then(capture).catch(failure => setError(failure instanceof Error ? failure.message : 'Could not open the browser.')); }}>Open browser</button></div>}
        <div className="browser-viewport">
          {frame
            ? <img ref={imageRef} src={frame.image} alt={`Interactive browser page: ${frame.title}`} draggable={false}
              onClick={event => { const point = viewportPoint(event); if (point) void act('click', point); }}
              onPointerMove={event => {
                if (event.buttons) return;
                const now = Date.now();
                if (now - lastMoveAt.current < 180) return;
                lastMoveAt.current = now;
                const point = viewportPoint(event);
                if (point) void act('move', point);
              }} />
            : <div className="browser-empty"><Globe size={25} /><span>{loading ? 'Loading page…' : 'Open a website to begin browsing.'}</span><button className="button button-secondary" onClick={() => { setAddress('https://example.com'); void api('/api/browser/navigate', { method: 'POST', body: JSON.stringify({ url: 'https://example.com' }) }).then(capture).catch(failure => setError(failure instanceof Error ? failure.message : 'Could not open the browser.')); }}>Open example.com</button></div>}
        </div>
        <div className="browser-controls">
          <form onSubmit={event => { event.preventDefault(); if (inputText) { void act('type', { text: inputText }); setInputText(''); } }}>
            <label className="sr-only" htmlFor="browser-keyboard-input">Type into the browser</label>
            <input id="browser-keyboard-input" value={inputText} onChange={event => setInputText(event.target.value)} placeholder="Type into the focused page…" />
            <button className="button button-secondary" disabled={!inputText || loading}>Type</button>
          </form>
          <form onSubmit={event => { event.preventDefault(); if (key.trim()) { void act('press', { key: key.trim() }); setKey(''); } }}>
            <label className="sr-only" htmlFor="browser-key-input">Press a key</label>
            <input id="browser-key-input" value={key} onChange={event => setKey(event.target.value)} placeholder="Key or chord, e.g. Enter" />
            <button className="button button-secondary" disabled={!key.trim() || loading}>Press</button>
          </form>
          <span className="browser-control-hint">Click page · Scroll over page · Type or press keys</span>
        </div>
      </section>
    </div>
  );
}

function configLabel(): string {
  return 'Symbiote';
}

function SessionsView(props: {
  sessions: SessionSummary[];
  query: string;
  onQuery: (query: string) => void;
  onOpen: (id: string) => void;
  onNew: () => void;
  creating: boolean;
}) {
  const { sessions, query, onQuery, onOpen, onNew, creating } = props;
  return (
    <div className="page">
      <PageHeading eyebrow="PERSISTED IN YOUR SESSION STORE" title="Session history" detail="Your conversations live alongside the runtime, ready to pick up where you left off." action={<button className="button button-primary" onClick={onNew} disabled={creating}><Plus size={16} />New conversation</button>} />
      <section className="surface-card sessions-panel">
        <div className="list-toolbar"><div className="toolbar-count">{sessions.length} <span>{sessions.length === 1 ? 'session' : 'sessions'}</span></div><label className="search-field"><Search size={16} /><input value={query} onChange={event => onQuery(event.target.value)} placeholder="Search sessions…" /><kbd>/</kbd></label></div>
        {sessions.length ? (
          <div className="session-table">
            <div className="session-table-head"><span>Conversation</span><span>Messages</span><span>Last active</span><span /></div>
            {sessions.map(session => (
              <button className="session-table-row" key={session.id} onClick={() => onOpen(session.id)}>
                <span className="session-table-name"><span className="conversation-avatar avatar-0">{initials(session.label)}</span><span><strong>{session.label || 'Untitled conversation'}</strong><small>{session.id}</small></span></span>
                <span className="session-message-count">{session.messageCount}</span>
                <span className="session-last-active">{formatRelative(session.updatedAt)}</span>
                <ArrowRight size={15} className="row-arrow" />
              </button>
            ))}
          </div>
        ) : (
          <EmptyState icon={Search} title={query ? 'No matches found.' : 'No sessions yet.'} detail={query ? 'Try a different name or clear the search.' : 'Create a conversation and it will be saved here automatically.'} action={!query ? <button className="button button-secondary" onClick={onNew}><Plus size={15} />Create a session</button> : undefined} />
        )}
      </section>
    </div>
  );
}

function OperationsView(props: {
  status: GatewayStatus | null;
  channels: GatewayStatus['channels'];
  logLines: string;
  query: string;
  onQuery: (query: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  lastUpdated: number | null;
  onRefresh: () => void;
}) {
  const { status, channels, logLines, query, onQuery, searchRef, lastUpdated, onRefresh } = props;
  const [copyStatus, setCopyStatus] = useState('');
  const filteredLogLines = query.trim()
    ? logLines.split(/\r?\n/).filter(line => line.toLowerCase().includes(query.trim().toLowerCase())).join('\n')
    : logLines;
  const health = status?.providerHealth;
  const providers = health && !Array.isArray(health) && typeof health === 'object' ? Object.entries(health) : [];
  const downloadLog = () => {
    const url = URL.createObjectURL(new Blob([logLines], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `symbiote-log-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const copyLog = async () => {
    try {
      await navigator.clipboard.writeText(filteredLogLines);
      setCopyStatus('Copied');
      window.setTimeout(() => setCopyStatus(''), 1800);
    } catch (failure) {
      setCopyStatus(failure instanceof Error ? `Copy failed: ${failure.message}` : 'Clipboard unavailable');
      window.setTimeout(() => setCopyStatus(''), 2500);
    }
  };
  return (
    <div className="page">
      <PageHeading eyebrow="THE RUNNING SYSTEM, NOT A SIMULATION" title="Operations" detail="Live adapter health, provider availability, and the service log from this machine." action={<button className="button button-secondary" onClick={onRefresh}><RefreshCw size={15} />Refresh now</button>} />
      <div className="operation-summary">
        <div className="operation-summary-mark"><Gauge size={19} /></div>
        <div className="operation-summary-copy"><strong>{status ? 'Gateway is responding' : 'Gateway is unreachable'}</strong><span>{status ? `Process ${status.pid ?? '—'} · Running for ${status.uptimeHuman ?? '—'} · ${status.activeTurns ?? 0} active turns` : 'Check that the Symbiote gateway process is running.'}</span></div>
        <span className={`status-tag${status ? ' status-tag-live' : ' status-tag-idle'}`}><span />{status ? 'Operational' : 'Offline'}</span>
      </div>
      <div className="operation-columns">
        <section className="surface-card operation-panel">
          <div className="section-heading"><div><div className="eyebrow">CHANNEL ADAPTERS</div><h2>Connections</h2></div><span className="subtle-label">{channels.length} TOTAL</span></div>
          {channels.length ? <div className="connection-list">{channels.map(channel => <ChannelTile key={channel.id} channel={channel} />)}</div> : <EmptyState icon={Network} title="No active connections" detail="The gateway has not registered any channel adapters." />}
        </section>
        <section className="surface-card operation-panel">
          <div className="section-heading"><div><div className="eyebrow">CIRCUIT BREAKERS</div><h2>Provider health</h2></div></div>
          {providers.length ? <div className="provider-list">{providers.map(([name, record]) => {
            const state = record && typeof record === 'object' && 'state' in record ? String(record.state) : 'unknown';
            const healthy = state === 'closed' || state === 'healthy' || state === 'available';
            return <div className="provider-row" key={name}><span className={`provider-health-dot${healthy ? ' provider-health-ok' : ''}`} /><span><strong>{name}</strong><small>{state}</small></span><span className="provider-latency">{record && typeof record === 'object' && 'avgLatencyMs' in record && typeof record.avgLatencyMs === 'number' ? `${record.avgLatencyMs} ms` : ''}</span></div>;
          })}</div> : <div className="inline-empty"><span className="empty-icon"><Activity size={17} /></span><div><strong>Provider health will appear as calls are made</strong><p>No provider health records have been reported yet.</p></div></div>}
        </section>
      </div>
      <section className="surface-card log-panel">
        <div className="section-heading log-heading"><div><div className="eyebrow">SERVICE OUTPUT · LOCAL MACHINE</div><h2>Recent log</h2></div><div className="log-actions"><span className="subtle-label">{lastUpdated ? `POLLING EVERY 5S` : 'AWAITING LOG'}</span><button className="button button-secondary log-action-button" onClick={() => void copyLog()} disabled={!filteredLogLines}>{copyStatus === 'Copied' ? <Check size={14} /> : <Copy size={14} />}{copyStatus || 'Copy'}</button><button className="button button-secondary log-action-button" onClick={downloadLog} disabled={!logLines}><Download size={14} />Save</button></div></div>
        <label className="search-field log-search"><Search size={15} /><input ref={searchRef} value={query} onChange={event => onQuery(event.target.value)} placeholder="Filter log lines…" aria-label="Filter log lines" /><kbd>/</kbd>{query && <button className="icon-button small" onClick={() => onQuery('')} aria-label="Clear log filter"><X size={13} /></button>}</label>
        <pre className="log-view" aria-label="Recent service log">{filteredLogLines || (query ? 'No log lines match this filter.' : 'No service log found yet. Start the gateway with log capture enabled to see runtime output here.')}</pre>
        <div className="log-caption"><span><span className="connection-orb connection-orb-live" />Tail of symbiote.log</span><span>{filteredLogLines ? `${filteredLogLines.split(/\r?\n/).length} visible lines` : 'Most recent 120 lines'} · Loopback only</span></div>
      </section>
    </div>
  );
}

function ToolsView(props: { tools: ToolSummary[]; total: number; query: string; onQuery: (query: string) => void }) {
  const { tools, total, query, onQuery } = props;
  return (
    <div className="page">
      <PageHeading eyebrow="CAPABILITIES REGISTERED BY THE RUNTIME" title="Tool registry" detail="Tools currently visible to the running Symbiote instance. Availability can vary by session policy." />
      <section className="surface-card tool-panel">
        <div className="list-toolbar"><div className="toolbar-count">{total} <span>registered tools</span></div><label className="search-field"><Search size={16} /><input value={query} onChange={event => onQuery(event.target.value)} placeholder="Find a tool…" /><kbd>/</kbd></label></div>
        {tools.length ? (
          <div className="tool-grid">{tools.map(tool => (
            <article className="tool-card" key={tool.name}><span className="tool-card-icon"><TerminalSquare size={17} /></span><div className="tool-card-title"><h3>{tool.name}</h3><span className="tool-chip">REGISTERED</span></div><p>{tool.description || 'No description provided.'}</p><div className="tool-card-footer"><span>Runtime tool</span><ArrowUpRight size={14} /></div></article>
          ))}</div>
        ) : <EmptyState icon={Wrench} title={query ? 'No tools match that search.' : 'No tools registered.'} detail={query ? 'Try a different tool name or description.' : 'The runtime did not report any available tools.'} />}
      </section>
      <div className="notice notice-info"><ShieldCheck size={16} /><span>The registry is informational. Each session is independently sandboxed, so not every tool is available to every conversation.</span></div>
    </div>
  );
}

function SettingsView({ config, status }: { config: GatewayConfig | null; status: GatewayStatus | null }) {
  const [lanToken, setLanToken] = useState('');
  const [tokenError, setTokenError] = useState('');
  const [tokenLoading, setTokenLoading] = useState(false);
  const [firewallStatus, setFirewallStatus] = useState('');
  const [firewallLoading, setFirewallLoading] = useState(false);

  const configureLanFirewall = async () => {
    if (!window.symbioteDesktop) return;
    setFirewallLoading(true);
    setFirewallStatus('');
    try {
      const result = await window.symbioteDesktop.requestLanAccess();
      setFirewallStatus(result.status === 'configured'
        ? 'Local-network access is allowed by Windows Firewall.'
        : result.status === 'declined'
          ? 'Access remains limited by Windows Firewall; the desktop app still works locally.'
          : result.status === 'loopback'
            ? 'The gateway is bound to this computer only; no firewall rule is needed.'
            : result.status === 'unsupported'
              ? 'Windows Firewall settings are available only in the Windows desktop app.'
              : 'The firewall rule was not changed. Local access remains available.');
    } catch (failure) {
      setFirewallStatus(failure instanceof Error ? failure.message : 'Could not configure Windows Firewall.');
    } finally {
      setFirewallLoading(false);
    }
  };

  const showLanToken = async () => {
    setTokenLoading(true);
    setTokenError('');
    try {
      const result = await api<{ token: string }>('/api/access/token');
      if (!result.token) throw new Error('The gateway has not created a LAN access token.');
      setLanToken(result.token);
    } catch (failure) {
      setTokenError(failure instanceof Error ? failure.message : 'Could not retrieve the LAN access token.');
    } finally {
      setTokenLoading(false);
    }
  };

  const copyLanToken = async () => {
    try {
      await navigator.clipboard.writeText(lanToken);
    } catch (failure) {
      setTokenError(failure instanceof Error ? failure.message : 'Could not copy the LAN access token.');
    }
  };

  return (
    <div className="page">
      <PageHeading eyebrow="WHAT THE RUNNING PROCESS REPORTS" title="Configuration" detail="A read-only view of the active runtime. Edit symbiote.json and restart the gateway to change these values." />
      <section className="surface-card settings-card">
        <div className="section-heading"><div><div className="eyebrow">MODEL ROUTING</div><h2>Provider & model</h2></div><span className="settings-source"><ShieldCheck size={14} />READ ONLY</span></div>
        <div className="settings-grid">
          <Setting label="Active provider" value={config?.provider || status?.provider?.split('/')[0]} />
          <Setting label="Active model" value={config?.model || status?.provider?.split('/').slice(1).join('/')} />
          <Setting label="Temperature" value={config?.temperature?.toString()} />
          <Setting label="Maximum response tokens" value={config?.maxTokens?.toLocaleString()} />
          <Setting label="Configured providers" value={config?.configuredProviders?.join(', ')} />
          <Setting label="Runtime version" value={config?.version} />
          <Setting label="Workspace" value={config?.workspace} wide />
        </div>
      </section>
      <section className="surface-card settings-card">
        <div className="section-heading"><div><div className="eyebrow">NETWORK BOUNDARIES</div><h2>Gateway endpoints</h2></div><span className="settings-source"><ShieldCheck size={14} />LOCAL API</span></div>
        <div className="settings-grid">
          <Setting label="Control room" value={config?.gateway ? `${config.gateway.webHost}:${config.gateway.webPort}` : undefined} />
          <Setting label="Agent API" value={config?.gateway ? `${config.gateway.apiHost}:${config.gateway.apiPort}` : undefined} />
          <Setting label="Authenticated API" value={config?.gateway ? (config.gateway.apiEnabled ? 'Enabled' : 'Disabled') : undefined} />
          <Setting label="Process ID" value={status?.pid?.toString()} />
        </div>
      </section>
      <section className="surface-card settings-card">
        <div className="section-heading"><div><div className="eyebrow">NETWORK ACCESS</div><h2>Connect another device</h2></div><span className="settings-source"><ShieldCheck size={14} />LOCAL ONLY</span></div>
        <p className="settings-access-copy">On a device on your trusted network, open the control room address above and enter this access token.</p>
        {lanToken ? (
          <div className="settings-token-row">
            <code>{lanToken}</code>
            <button className="button button-secondary" type="button" onClick={() => void copyLanToken()}><Copy size={14} />Copy</button>
          </div>
        ) : (
          <button className="button button-secondary" type="button" disabled={tokenLoading} onClick={() => void showLanToken()}>{tokenLoading ? <LoaderCircle size={14} className="spin" /> : <ShieldCheck size={14} />}{tokenLoading ? 'Loading token' : 'Reveal LAN token'}</button>
        )}
        {tokenError && <p className="settings-token-error" role="alert">{tokenError}</p>}
        {window.symbioteDesktop && <div className="settings-firewall">
          <button className="button button-secondary" type="button" disabled={firewallLoading} onClick={() => void configureLanFirewall()}>
            {firewallLoading ? <LoaderCircle size={14} className="spin" /> : <ShieldCheck size={14} />}
            {firewallLoading ? 'Waiting for permission' : 'Configure Windows Firewall'}
          </button>
          {firewallStatus && <p className="settings-token-error" role="status">{firewallStatus}</p>}
        </div>}
      </section>
      <div className="notice notice-info"><ShieldCheck size={16} /><span>Credentials are never sent to the browser. For safety, configuration changes are made in your local config file—not through this page.</span></div>
    </div>
  );
}

function Setting({ label, value, wide }: { label: string; value?: string; wide?: boolean }) {
  return <div className={`setting-field${wide ? ' setting-wide' : ''}`}><span>{label}</span><strong>{value || 'Not reported'}</strong></div>;
}
