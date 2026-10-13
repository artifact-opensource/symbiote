import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { ReactNode, RefObject } from 'react';
import Markdown from 'react-markdown';
import {
  Activity, ArrowRight, ArrowUpRight, Bot, ChevronDown, Command, FileClock, Gauge, HardDrive, LayoutDashboard, LoaderCircle,
  Menu, MessageSquare, Network, Plus, RefreshCw, Search, Send, Server, Settings2,
  ShieldCheck, Sparkles, TerminalSquare, Wrench, X,
} from 'lucide-react';
import type { ChatMessage, GatewayConfig, GatewayStatus, SessionSummary, ToolSummary, ViewId } from './types';

const NAVIGATION: { id: ViewId; label: string; icon: typeof LayoutDashboard; group: string }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard, group: 'Workspace' },
  { id: 'chat', label: 'Conversations', icon: MessageSquare, group: 'Workspace' },
  { id: 'sessions', label: 'Session history', icon: FileClock, group: 'Workspace' },
  { id: 'operations', label: 'Operations', icon: Activity, group: 'Runtime' },
  { id: 'tools', label: 'Tool registry', icon: Wrench, group: 'Runtime' },
  { id: 'settings', label: 'Configuration', icon: Settings2, group: 'Runtime' },
];

async function api<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const response = await fetch(endpoint, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  const payload = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload as T;
}

function formatRelative(timestamp?: number): string {
  if (!timestamp) return 'No activity yet';
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 60_000) return 'Just now';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return new Date(timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function formatBytes(megabytes?: number): string {
  if (typeof megabytes !== 'number') return '—';
  return megabytes >= 1024 ? `${(megabytes / 1024).toFixed(1)} GB` : `${Math.round(megabytes)} MB`;
}

function initials(label?: string): string {
  return (label || 'S').trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase();
}

function MessageBody({ content }: { content: string }) {
  return (
    <div className="message-markdown">
      <Markdown>{content}</Markdown>
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

export default function App() {
  const [view, setView] = useState<ViewId>('overview');
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [config, setConfig] = useState<GatewayConfig | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [tools, setTools] = useState<ToolSummary[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [logLines, setLogLines] = useState('');
  const [memoryHistory, setMemoryHistory] = useState<number[]>([]);
  const [activeSessionId, setActiveSessionId] = useState('');
  const [draft, setDraft] = useState('');
  const [sessionQuery, setSessionQuery] = useState('');
  const [toolQuery, setToolQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sending, setSending] = useState(false);
  const [creatingSession, setCreatingSession] = useState(false);
  const [error, setError] = useState('');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const activeSession = sessions.find(session => session.id === activeSessionId);
  const currentNavigation = NAVIGATION.find(item => item.id === view) ?? NAVIGATION[0];

  const refreshStatus = useCallback(async () => {
    const fresh = await api<GatewayStatus>('/api/status');
    setStatus(fresh);
    setMemoryHistory(previous => [...previous.slice(-23), fresh.memory?.rss ?? 0]);
    setLastUpdated(Date.now());
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
    ]);
    const firstError = results.find(result => result.status === 'rejected');
    if (firstError?.status === 'rejected') setError(firstError.reason instanceof Error ? firstError.reason.message : 'Could not load gateway data.');
    setLoading(false);
    if (showSpinner) setRefreshing(false);
  }, [refreshStatus]);

  useEffect(() => {
    void refreshAll();
    const timer = window.setInterval(() => {
      void refreshStatus().catch(() => setError('Gateway connection was interrupted. Retrying…'));
      if (view === 'operations') {
        void api<{ lines: string }>('/api/logs?lines=120')
          .then(result => setLogLines(result.lines))
          .catch(() => undefined);
      }
    }, 5000);
    return () => window.clearInterval(timer);
  }, [refreshAll, refreshStatus, view]);

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

  const sendMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !activeSessionId || sending) return;
    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: text, timestamp: Date.now() };
    setMessages(previous => [...previous, userMessage]);
    setDraft('');
    setSending(true);
    setError('');
    try {
      const response = await api<{
        text: string;
        durationMs?: number;
        iterations?: number;
        toolCalls?: Array<{ name: string; input: Record<string, unknown>; result: string }>;
      }>('/api/chat', {
        method: 'POST',
        body: JSON.stringify({ text, sessionId: activeSessionId }),
      });
      setMessages(previous => [...previous, {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: response.text || 'The turn completed without a text response.',
        timestamp: Date.now(),
        durationMs: response.durationMs,
        iterations: response.iterations,
        toolCalls: response.toolCalls ?? [],
      }]);
      void api<SessionSummary[]>('/api/sessions').then(setSessions).catch(() => undefined);
      void refreshStatus().catch(() => undefined);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Message could not be delivered.');
    } finally {
      setSending(false);
    }
  };

  const channelList = status?.channels ?? [];
  const onlineChannels = channelList.filter(channel => channel.status === 'running' || channel.health?.state === 'connected').length;
  const isOnline = Boolean(status);

  return (
    <div className="control-room">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <aside className={`sidebar${mobileNavOpen ? ' sidebar-open' : ''}`} aria-label="Main navigation">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
          <div className="brand-copy"><span>SYMBIOTE</span><small>LOCAL AGENT SYSTEM</small></div>
          <button className="icon-button sidebar-dismiss" onClick={() => setMobileNavOpen(false)} aria-label="Close navigation"><X size={17} /></button>
        </div>

        <button className="workspace-switcher" onClick={() => navigate('overview')} aria-label="Current workspace">
          <span className="workspace-avatar">S</span>
          <span className="workspace-copy"><strong>Symbiote runtime</strong><small>{config?.workspace || 'Local workspace'}</small></span>
          <ChevronDown size={14} className="muted-icon" />
        </button>

        {['Workspace', 'Runtime'].map(group => (
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
                </button>
              );
            })}
          </div>
        ))}

        <div className="sidebar-spacer" />
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
          <span className={`connection-orb${isOnline ? ' connection-orb-live' : ''}`} />
          <span>{isOnline ? 'Runtime connected' : 'Connecting to runtime'}</span>
          <span className="version-label">v{status?.version ?? '—'}</span>
        </div>
      </aside>

      {mobileNavOpen && <button className="mobile-scrim" onClick={() => setMobileNavOpen(false)} aria-label="Close navigation overlay" />}

      <div className="main-column">
        <header className="topbar">
          <div className="topbar-left">
            <button className="icon-button mobile-menu" onClick={() => setMobileNavOpen(true)} aria-label="Open navigation"><Menu size={19} /></button>
            <div className="breadcrumb"><span>Symbiote</span><span className="breadcrumb-divider">/</span><strong>{currentNavigation.label}</strong></div>
          </div>
          <div className="topbar-right">
            <span className={`live-indicator${isOnline ? ' live-indicator-on' : ''}`}><span />{isOnline ? 'LIVE' : 'OFFLINE'}</span>
            <span className="topbar-separator" />
            <span className="topbar-provider">{status?.provider || 'Runtime unavailable'}</span>
            <button className={`icon-button refresh-button${refreshing ? ' is-refreshing' : ''}`} onClick={() => void refreshAll(true)} aria-label="Refresh runtime data" disabled={refreshing}>
              <RefreshCw size={16} />
            </button>
            <span className="profile-avatar" aria-label="Local operator">A</span>
          </div>
        </header>

        <main id="main-content" className="main-content">
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
              {view === 'overview' && (
                <OverviewView
                  status={status}
                  sessions={sessions}
                  channels={channelList}
                  onlineChannels={onlineChannels}
                  memoryHistory={memoryHistory}
                  lastUpdated={lastUpdated}
                  onNavigate={navigate}
                  onNewSession={() => void createSession()}
                  onOpenSession={id => { setActiveSessionId(id); navigate('chat'); }}
                  creatingSession={creatingSession}
                />
              )}
              {view === 'chat' && (
                <ChatView
                  session={activeSession}
                  sessions={sessions}
                  messages={messages}
                  draft={draft}
                  sending={sending}
                  onDraft={setDraft}
                  onSubmit={sendMessage}
                  onNewSession={() => void createSession()}
                  onSelectSession={id => setActiveSessionId(id)}
                  bottomRef={bottomRef}
                  creatingSession={creatingSession}
                />
              )}
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
              {view === 'operations' && (
                <OperationsView
                  status={status}
                  channels={channelList}
                  logLines={logLines}
                  lastUpdated={lastUpdated}
                  onRefresh={() => void refreshAll(true)}
                />
              )}
              {view === 'tools' && (
                <ToolsView tools={filteredTools} total={tools.length} query={toolQuery} onQuery={setToolQuery} />
              )}
              {view === 'settings' && <SettingsView config={config} status={status} />}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

function PageHeading({ eyebrow, title, detail, action }: {
  eyebrow: string;
  title: string;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{detail}</p></div>
      {action}
    </div>
  );
}

function OverviewView(props: {
  status: GatewayStatus | null;
  sessions: SessionSummary[];
  channels: GatewayStatus['channels'];
  onlineChannels: number;
  memoryHistory: number[];
  lastUpdated: number | null;
  onNavigate: (view: ViewId) => void;
  onNewSession: () => void;
  onOpenSession: (id: string) => void;
  creatingSession: boolean;
}) {
  const { status, sessions, channels, onlineChannels, memoryHistory, lastUpdated, onNavigate, onNewSession, onOpenSession, creatingSession } = props;
  const memory = status?.memory;
  const metrics = status?.metrics;
  const latestSessions = sessions.slice(0, 4);
  return (
    <div className="page page-overview">
      <PageHeading
        eyebrow="YOUR LOCAL AGENT, AT A GLANCE"
        title="Good to have you back."
        detail="A clear view of the runtime, its connections, and the work in progress."
        action={<button className="button button-primary" onClick={onNewSession} disabled={creatingSession}><Plus size={16} />New conversation</button>}
      />

      <section className="overview-banner">
        <div className="banner-orbit orbit-one" /><div className="banner-orbit orbit-two" />
        <div className="banner-copy">
          <div className="banner-kicker"><span className="banner-status-dot" /> LOCAL RUNTIME {status ? 'CONNECTED' : 'WAITING'}</div>
          <h2>{status?.provider ? <>Working with <span>{status.provider.split('/')[0]}</span></> : 'Waiting for your runtime'}</h2>
          <p>{status?.provider ? `Model ${status.provider.split('/').slice(1).join('/') || 'configured'} · ${status.activeTurns ?? 0} active ${status.activeTurns === 1 ? 'turn' : 'turns'}` : 'Start the Symbiote gateway to bring your control room online.'}</p>
          <button className="banner-link" onClick={() => onNavigate('operations')}>View runtime details <ArrowRight size={15} /></button>
        </div>
        <div className="banner-illustration" aria-hidden="true">
          <div className="core-ring ring-outer" /><div className="core-ring ring-mid" /><div className="core-ring ring-inner" />
          <span className="core-center"><span /></span>
          <span className="core-satellite satellite-a" /><span className="core-satellite satellite-b" /><span className="core-satellite satellite-c" />
        </div>
        <div className="banner-index">SYS / 01</div>
      </section>

      <section className="metric-grid" aria-label="Runtime summary">
        <MetricCard icon={Server} label="Uptime" value={status?.uptimeHuman || '—'} detail={`Version ${status?.version ?? 'unknown'}`} tone="neutral" />
        <MetricCard icon={Network} label="Connected channels" value={`${onlineChannels} / ${channels.length}`} detail={channels.length ? 'Live adapter health' : 'No adapters registered'} tone="green" />
        <MetricCard icon={Activity} label="Active turns" value={String(status?.activeTurns ?? '—')} detail="Currently processing" tone="orange" />
        <MetricCard icon={HardDrive} label="Memory in use" value={formatBytes(memory?.rss)} detail={`Heap ${formatBytes(memory?.heap)}`} tone="blue" />
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
            <div className="runtime-footnote"><span>Resident set size</span><span>Live · 5 second interval</span></div>
          </div>
          <div className="runtime-divider" />
          <div className="runtime-mini-grid">
            <div><span>Sessions stored</span><strong>{status?.sessions ?? sessions.length}</strong></div>
            <div><span>Tools registered</span><strong>{status?.tools ?? '—'}</strong></div>
            <div><span>Turns recorded</span><strong>{metrics?.totalTurns ?? metrics?.turns ?? '—'}</strong></div>
            <div><span>Node process</span><strong>{status?.pid ? `PID ${status.pid}` : '—'}</strong></div>
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
      <div className="page-footnote"><span>LOCAL FIRST BY DESIGN</span><span>{status?.pid ? `PROCESS ${status.pid}` : 'RUNTIME NOT CONNECTED'}</span></div>
    </div>
  );
}

function MetricCard({ icon: Icon, label, value, detail, tone }: {
  icon: typeof Activity;
  label: string;
  value: string;
  detail: string;
  tone: 'neutral' | 'green' | 'orange' | 'blue';
}) {
  return (
    <div className="metric-card">
      <div className="metric-card-top"><span className={`metric-icon metric-${tone}`}><Icon size={16} strokeWidth={1.8} /></span><span className="metric-label">{label}</span></div>
      <strong className="metric-value">{value}</strong>
      <span className="metric-detail">{detail}</span>
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
  onNewSession: () => void;
  onSelectSession: (id: string) => void;
  bottomRef: RefObject<HTMLDivElement | null>;
  creatingSession: boolean;
}) {
  const { session, sessions, messages, draft, sending, onDraft, onSubmit, onNewSession, onSelectSession, bottomRef, creatingSession } = props;
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
                {!!message.toolCalls?.length && (
                  <details className="tool-activity">
                    <summary><Wrench size={14} />{message.toolCalls.length} {message.toolCalls.length === 1 ? 'tool action' : 'tool actions'}<ChevronDown size={14} /></summary>
                    <div className="tool-activity-list">{message.toolCalls.map((call, index) => <div key={`${call.name}-${index}`}><code>{call.name}</code><span>{call.result.slice(0, 280) || 'Completed'}</span></div>)}</div>
                  </details>
                )}
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
          {sending && <div className="thinking-row"><span className="thinking-pulse" /><span>Agent is working</span><span className="thinking-caption">You can keep this window open.</span></div>}
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
            disabled={!session || sending}
          />
          <div className="composer-bottom">
            <span><Command size={12} /> Enter to send <span className="composer-divider">·</span> Shift + Enter for a new line</span>
            <button className="send-button" type="submit" disabled={!draft.trim() || !session || sending} aria-label="Send message">
              {sending ? <LoaderCircle size={17} className="spin" /> : <Send size={16} />}<span>Send</span>
            </button>
          </div>
        </form>
        <div className="chat-assurance"><ShieldCheck size={13} /> Messages stay in your local Symbiote session store.</div>
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
  lastUpdated: number | null;
  onRefresh: () => void;
}) {
  const { status, channels, logLines, lastUpdated, onRefresh } = props;
  const health = status?.providerHealth;
  const providers = health && !Array.isArray(health) && typeof health === 'object' ? Object.entries(health) : [];
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
        <div className="section-heading"><div><div className="eyebrow">SERVICE OUTPUT · LOCAL MACHINE</div><h2>Recent log</h2></div><span className="subtle-label">{lastUpdated ? `POLLING EVERY 5S` : 'AWAITING LOG'}</span></div>
        <pre className="log-view" aria-label="Recent service log">{logLines || 'No service log found yet. Start the gateway with log capture enabled to see runtime output here.'}</pre>
        <div className="log-caption"><span><span className="connection-orb connection-orb-live" />Tail of symbiote.log</span><span>Most recent 120 lines · Loopback only</span></div>
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
      <div className="notice notice-info"><ShieldCheck size={16} /><span>Credentials are never sent to the browser. For safety, configuration changes are made in your local config file—not through this page.</span></div>
    </div>
  );
}

function Setting({ label, value, wide }: { label: string; value?: string; wide?: boolean }) {
  return <div className={`setting-field${wide ? ' setting-wide' : ''}`}><span>{label}</span><strong>{value || 'Not reported'}</strong></div>;
}
