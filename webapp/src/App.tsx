import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent as ReactMouseEvent } from 'react';
import type { ReactNode, RefObject } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Activity, ArrowRight, ArrowUpRight, Bell, Bot, Check, ChevronDown, CircleAlert, CircleCheck, Clock3, Command, Copy, Cpu,
  Archive, Bookmark, Brain, Cloud, Database, Download, Gauge, Globe, HardDrive, History, Info, LayoutDashboard, Leaf, Maximize2, Menu, MessageSquare, Minimize2, Moon, Network,
  Biohazard, ChevronUp, FolderOpen, MessagesSquare, Plus, Power, RefreshCw, Search, Send, Server, Settings2, ShieldCheck, SlidersHorizontal, Sparkles, Sun, TerminalSquare, Thermometer, Upload, Users, Workflow, Wrench, X,
} from 'lucide-react';
import type { AgentProfile, ChatMessage, GatewayConfig, GatewayStatus, HostResourceSnapshot, MemoryNodeContext, SessionSummary, ThreadUserHelpRequest, ToolSummary, ViewId, WorkspaceAgent, WorkspaceProject, WorkspaceRun } from './types';
import type { CloudProviderStatus, GoogleWorkspaceGrant } from './components/IntegrationsView';
import ActivityOrb from './components/ActivityOrb';
import BrowserLoading from './components/BrowserLoading';
import { getActivityFromStatus, getActivityOrbState, getToolActivity, isAgentActivity, type AgentActivity } from './components/activity-orb-state';
import HeroAgentOrb from './components/HeroAgentOrb';
import ReasoningDisplay from './components/ReasoningDisplay';
import CronPanel from './components/CronPanel';
import ThreadsPanel from './components/ThreadsPanel';
import { AgentIcon as AgentGlyph, AgentIconPicker } from './components/AgentIconPicker';

declare const __SYMBIOTE_VERSION__: string;

const GamesView = lazy(() => import('./components/GamesView'));
const MemoryMap = lazy(() => import('./components/MemoryMap'));
const IntegrationsView = lazy(() => import('./components/IntegrationsView'));
const ProjectIDE = lazy(() => import('./components/ProjectIDE'));
const ProjectsPanel = lazy(() => import('./components/ProjectsPanel'));

const NAVIGATION: { id: ViewId; label: string; icon: typeof LayoutDashboard; group: string }[] = [
  { id: 'workspace', label: 'Overview', icon: LayoutDashboard, group: 'Work' },
  { id: 'projects', label: 'Projects', icon: FolderOpen, group: 'Work' },
  { id: 'agents', label: 'Agents', icon: Users, group: 'Work' },
  { id: 'runs', label: 'Tasks', icon: Activity, group: 'Work' },
  { id: 'threads', label: 'Threads', icon: MessagesSquare, group: 'Play' },
  { id: 'games', label: 'Zen', icon: Leaf, group: 'Play' },
  { id: 'browser', label: 'Browser', icon: Globe, group: 'Tools' },
  { id: 'ide', label: 'IDE', icon: TerminalSquare, group: 'Tools' },
  { id: 'tools', label: 'Tool registry', icon: Wrench, group: 'Tools' },
  { id: 'memory', label: 'Memory', icon: Brain, group: 'Runtime' },
  { id: 'integrations', label: 'Integrations', icon: Network, group: 'Runtime' },
  { id: 'settings', label: 'Configuration', icon: Settings2, group: 'Runtime' },
  { id: 'operations', label: 'Health', icon: Activity, group: 'Runtime' },
];

const REFRESH_INTERVAL_KEY = 'symbiote-telemetry-refresh-ms';
const MIN_REFRESH_INTERVAL_MS = 3000;
const MAX_REFRESH_INTERVAL_MS = 5000;

interface AgentLightingState {
  agentActiveNodes: Set<string>;
  projectPendingNodes: Map<string, string>;
  agentResponseNodes: Map<string, string>;
}

function readRefreshInterval(): number {
  try {
    const value = Number(window.localStorage.getItem(REFRESH_INTERVAL_KEY));
    return Number.isFinite(value) && value >= MIN_REFRESH_INTERVAL_MS && value <= MAX_REFRESH_INTERVAL_MS
      ? value
      : MIN_REFRESH_INTERVAL_MS;
  } catch {
    return MIN_REFRESH_INTERVAL_MS;
  }
}

type Theme = 'light' | 'dark';
type AppearanceSettings = { brightness: number; primaryHue: number; secondaryHue: number };

function parseAppearanceSettings(value: unknown): AppearanceSettings | null {
  if (!value || typeof value !== 'object') return null;
  const settings = value as Partial<AppearanceSettings>;
  if (typeof settings.brightness !== 'number' || !Number.isFinite(settings.brightness) || settings.brightness < 0 || settings.brightness > 100
    || typeof settings.primaryHue !== 'number' || !Number.isFinite(settings.primaryHue) || settings.primaryHue < 0 || settings.primaryHue > 360
    || typeof settings.secondaryHue !== 'number' || !Number.isFinite(settings.secondaryHue) || settings.secondaryHue < 0 || settings.secondaryHue > 360) return null;
  return {
    brightness: settings.brightness,
    primaryHue: settings.primaryHue,
    secondaryHue: settings.secondaryHue,
  };
}

function initialAppearance(): AppearanceSettings {
  const fallbackBrightness = (() => {
    try {
      const savedTheme = window.localStorage.getItem('symbiote-theme');
      if (savedTheme === 'dark') return 0;
      if (savedTheme === 'light') return 100;
    } catch {
      // Use the system preference when local storage is unavailable.
    }
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 0 : 100;
  })();
  try {
    const stored = window.localStorage.getItem('symbiote-appearance');
    if (stored) {
      const parsed: unknown = JSON.parse(stored);
      if (parsed && typeof parsed === 'object') {
        const settings = parsed as Partial<AppearanceSettings>;
        return {
          brightness: Number.isFinite(settings.brightness) ? Math.min(100, Math.max(0, settings.brightness!)) : fallbackBrightness,
          primaryHue: Number.isFinite(settings.primaryHue) ? Math.min(360, Math.max(0, settings.primaryHue!)) : 145,
          secondaryHue: Number.isFinite(settings.secondaryHue) ? Math.min(360, Math.max(0, settings.secondaryHue!)) : 13,
        };
      }
    }
  } catch {
    // Invalid saved settings are ignored.
  }
  return { brightness: fallbackBrightness, primaryHue: 145, secondaryHue: 13 };
}

function createClientId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

declare global {
  interface Window {
    symbioteDesktop?: {
      supportsReboot: boolean;
      openMini(): Promise<void>;
      expand(): Promise<void>;
      closeMini(): Promise<void>;
      getOpacity(): Promise<number>;
      setOpacity(opacity: number): Promise<number>;
      setTheme(theme: Theme): Promise<Theme>;
      requestLanAccess(): Promise<{ status: string }>;
      installUpdate(): Promise<boolean>;
      requestReboot(): Promise<void>;
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

function GoogleWorkspaceMark() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M23.5 12.27c0-.78-.07-1.53-.2-2.27H12v4.3h6.45a5.52 5.52 0 0 1-2.39 3.62v3h3.87c2.27-2.09 3.57-5.16 3.57-8.65Z" /><path fill="currentColor" d="M12 24c3.24 0 5.96-1.08 7.95-2.92l-3.87-3c-1.08.72-2.46 1.15-4.08 1.15-3.13 0-5.78-2.11-6.73-4.95H1.27v3.1A12 12 0 0 0 12 24Z" /><path fill="currentColor" d="M5.27 14.28a7.2 7.2 0 0 1 0-4.56v-3.1H1.27a12 12 0 0 0 0 10.76l4-3.1Z" /><path fill="currentColor" d="M12 4.77c1.77 0 3.35.61 4.6 1.8l3.43-3.42A11.5 11.5 0 0 0 12 0 12 12 0 0 0 1.27 6.62l4 3.1c.95-2.84 3.6-4.95 6.73-4.95Z" /></svg>;
}

function initialTheme(): Theme {
  return initialAppearance().brightness >= 50 ? 'light' : 'dark';
}

function hslRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const h = ((hue % 360) + 360) % 360 / 360;
  const s = saturation / 100;
  const l = lightness / 100;
  const channel = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [channel(0), channel(8), channel(4)];
}

function contrastInk(rgb: [number, number, number]): string {
  const luminance = rgb.reduce((total, channel, index) => {
    const linear = channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    return total + linear * [0.2126, 0.7152, 0.0722][index];
  }, 0);
  const blackContrast = (luminance + 0.05) / 0.05;
  const whiteContrast = 1.05 / (luminance + 0.05);
  return whiteContrast > blackContrast ? '#ffffff' : '#000000';
}

function AppearanceControl({
  settings,
  onChange,
}: {
  settings: AppearanceSettings;
  onChange: (settings: AppearanceSettings) => void;
}) {
  const brightnessLabel = settings.brightness === 0
    ? 'AMOLED black'
    : settings.brightness === 100
      ? 'Full light'
      : settings.brightness < 50 ? 'Deep' : 'Bright';
  return (
    <details className="appearance-anchor">
      <summary className="icon-button utility-button appearance-trigger" aria-label="Open appearance controls" title="Appearance">
        <SlidersHorizontal size={16} />
      </summary>
      <section className="appearance-popover" aria-label="Appearance controls">
        <header className="appearance-popover-heading">
          <span className="appearance-heading-mark"><SlidersHorizontal size={15} /></span>
          <span><strong>Appearance</strong><small>One palette, across the whole workspace</small></span>
        </header>
        <section className="appearance-brightness" aria-labelledby="appearance-brightness-label">
          <div className="appearance-control-heading">
            <span id="appearance-brightness-label">Brightness</span>
            <output>{brightnessLabel} · {settings.brightness}%</output>
          </div>
          <div className="appearance-brightness-ends" aria-hidden="true"><span>OLED black</span><span>Daylight</span></div>
          <input
            className="appearance-range appearance-range-brightness"
            type="range"
            min={0}
            max={100}
            value={settings.brightness}
            aria-label="Brightness from AMOLED black to full light"
            onChange={event => onChange({ ...settings, brightness: Number(event.target.value) })}
          />
        </section>
        <div className="appearance-divider" />
        <section className="appearance-hue-controls" aria-label="Color controls">
          <label className="appearance-hue-control">
            <span className="appearance-control-heading">
              <span><i className="appearance-color-swatch appearance-swatch-primary" aria-hidden="true" />Primary</span>
              <output>{Math.round(settings.primaryHue)}°</output>
            </span>
            <small>Hero, page headings, and primary controls</small>
            <input
              className="appearance-range appearance-range-hue"
              type="range"
              min={0}
              max={360}
              value={settings.primaryHue}
              aria-label="Primary hue for workspace and sidebar"
              onChange={event => onChange({ ...settings, primaryHue: Number(event.target.value) })}
            />
          </label>
          <label className="appearance-hue-control">
            <span className="appearance-control-heading">
              <span><i className="appearance-color-swatch appearance-swatch-secondary" aria-hidden="true" />Accent</span>
              <output>{Math.round(settings.secondaryHue)}°</output>
            </span>
            <small>Icons, focus, and active details</small>
            <input
              className="appearance-range appearance-range-hue"
              type="range"
              min={0}
              max={360}
              value={settings.secondaryHue}
              aria-label="Accent hue for icons and focus states"
              onChange={event => onChange({ ...settings, secondaryHue: Number(event.target.value) })}
            />
          </label>
        </section>
      </section>
    </details>
  );
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
    if (event.type === 'done') {
      const result = event.result ?? event.message ?? event;
      if (result && typeof result === 'object') {
        const payload = result as Record<string, unknown>;
        finalResult = {
          ...payload,
          text: typeof payload.text === 'string' ? payload.text : typeof payload.content === 'string' ? payload.content : '',
          durationMs: payload.durationMs ?? payload.latencyMs,
          inputTokens: payload.inputTokens ?? payload.tokensIn,
          outputTokens: payload.outputTokens ?? payload.tokensOut,
        } as T;
      }
    } else if (event.type === 'text') {
      onEvent({ ...event, type: 'text_delta', text: event.text ?? event.content });
    } else {
      onEvent(event);
    }
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

function formatChatElapsed(durationMs?: number): string {
  if (durationMs === undefined || !Number.isFinite(durationMs)) return '—';
  if (durationMs < 1000) return `${Math.max(0, Math.round(durationMs))} ms`;
  return `${(durationMs / 1000).toFixed(1)} s`;
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

type TodoActivityItem = NonNullable<ChatMessage['todoActivity']>[number];

function readTodoActivityItem(value: unknown): TodoActivityItem | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  const statuses = ['pending', 'in_progress', 'blocked', 'completed'];
  if (typeof item.id !== 'string' || typeof item.title !== 'string' || !statuses.includes(String(item.status))) return undefined;
  return { id: item.id, title: item.title, status: item.status as TodoActivityItem['status'] };
}

function mergeTodoActivity(
  current: TodoActivityItem[] = [],
  completedValue: unknown,
  remainingValue: unknown,
): TodoActivityItem[] {
  const completed = readTodoActivityItem(completedValue);
  if (!completed) return current;
  const remaining = Array.isArray(remainingValue)
    ? remainingValue.map(readTodoActivityItem).filter((item): item is TodoActivityItem => item !== undefined)
    : [];
  const latestById = new Map(current.map(item => [item.id, item]));
  for (const item of remaining) latestById.set(item.id, item);
  latestById.set(completed.id, { ...completed, status: 'completed' });

  const ordered = [
    latestById.get(completed.id)!,
    ...current.map(item => latestById.get(item.id)!),
    ...remaining.map(item => latestById.get(item.id)!),
  ];
  const seen = new Set<string>();
  return ordered.filter(item => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function TodoActivityBubble({ items }: { items: TodoActivityItem[] }) {
  if (!items.length) return null;
  const [latest, ...older] = items;
  return (
    <div className="todo-activity" aria-label="Live todo checklist">
      <div className="todo-activity-current">
        <input type="checkbox" checked={latest.status === 'completed'} readOnly aria-label={latest.status === 'completed' ? 'Completed' : 'Not completed'} />
        <span>{latest.title}</span>
      </div>
      {older.length > 0 && (
        <details>
          <summary>{older.length} other checklist {older.length === 1 ? 'item' : 'items'}<ChevronDown size={13} /></summary>
          <div className="todo-activity-list">
            {older.map(item => (
              <div key={item.id}>
                <input type="checkbox" checked={item.status === 'completed'} readOnly aria-label={item.status === 'completed' ? 'Completed' : 'Not completed'} />
                <span>{item.title}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function MinimalMode({ theme, agentName, agentEmoji, agentAvatarDataUrl, onThemeChange }: {
  theme: Theme;
  agentName?: string;
  agentEmoji?: string;
  agentAvatarDataUrl?: string;
  onThemeChange: () => void;
}) {
  const [tab, setTab] = useState<'chat' | 'history' | 'agents' | 'tasks'>('chat');
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [agents, setAgents] = useState<WorkspaceAgent[]>([]);
  const [runs, setRuns] = useState<WorkspaceRun[]>([]);
  const [text, setText] = useState('');
  const [opacity, setOpacity] = useState(0.88);
  const [opacityControlsOpen, setOpacityControlsOpen] = useState(false);
  const opacityRevisionRef = useRef(0);
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
    const timer = window.setInterval(() => void refresh(), tab === 'tasks' ? 1000 : 5000);
    return () => window.clearInterval(timer);
  }, [refresh, tab]);



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
    setMessages(current => [...current, { id: `pending-${Date.now()}`, role: 'user', content: message, timestamp: Date.now() }, { id: assistantId, role: 'assistant', content: '', streaming: true, thinking: true, activityState: 'thinking', timestamp: Date.now() }]);
    try {
      const outcome = await streamApi<{ text: string }>('/api/chat', { text: message, sessionId: activeSessionId }, event => {
        if (event.type === 'todo_update') {
          setMessages(current => current.map(item => item.id === assistantId
            ? { ...item, todoActivity: mergeTodoActivity(item.todoActivity, event.completedTodo, event.remainingTodos) }
            : item));
          return;
        }
        setMessages(current => current.map(item => {
          if (item.id !== assistantId) return item;
          if (event.type === 'text_delta') return { ...item, content: item.content + String(event.text ?? ''), thinking: false, activityState: 'responding' };
          if (event.type === 'thinking_delta') return { ...item, thinking: true, activityState: 'reasoning' };
          if (event.type === 'tool_start') {
            const name = String(event.name ?? 'tool');
            return { ...item, thinking: false, activityState: getToolActivity(name).activity, activeTool: name, activeTools: [...(item.activeTools ?? []), name] };
          }
          if (event.type === 'tool_end') {
            const name = String(event.name ?? 'tool');
            const activeTools = (item.activeTools ?? []).filter((tool, index, tools) => tool !== name || index !== tools.lastIndexOf(name));
            return { ...item, activeTools, activeTool: activeTools.at(-1), thinking: activeTools.length === 0, activityState: activeTools.length ? getToolActivity(activeTools.at(-1)!).activity : 'thinking' };
          }
          return item;
        }));
        if (event.type === 'text_delta') streamedText += String(event.text ?? '');
      });
      if (!outcome.complete) {
        const saved = await api<ChatMessage[]>(`/api/sessions/${encodeURIComponent(activeSessionId)}/messages`);
        const latestAssistant = findSavedAssistantResponse(saved, message);
        if (latestAssistant) {
          setMessages(saved);
        } else {
          setMessages(current => current.map(item => item.id === assistantId
            ? { ...item, content: streamedText, streaming: false, activeTools: [], activeTool: undefined, todoActivity: [], interrupted: true }
            : item));
        }
        return;
      }
      const result = outcome.result;
      await refresh();
      const saved = await api<ChatMessage[]>(`/api/sessions/${encodeURIComponent(activeSessionId)}/messages`);
      setMessages(saved.length ? saved : current => current.map(item => item.id === assistantId
        ? { ...item, content: result.text, streaming: false, activeTools: [], activeTool: undefined, todoActivity: [] }
        : item));
    } catch (failure) {
      setMessages(current => current.map(item => item.id === assistantId ? {
        ...item,
        content: item.content || streamedText || (failure instanceof Error ? failure.message : 'The agent turn failed.'),
        streaming: false,
        activeTools: [],
        activeTool: undefined,
        todoActivity: [],
        interrupted: true,
      } : item));
    } finally {
      setBusy(false);
      setActiveTurnSessionId('');
    }
  };

  const updateOpacity = async (value: number) => {
    const revision = ++opacityRevisionRef.current;
    setOpacity(value);
    try {
      const applied = await window.symbioteDesktop?.setOpacity(value);
      if (revision === opacityRevisionRef.current && applied !== undefined) setOpacity(applied);
    } catch (failure) {
      if (revision !== opacityRevisionRef.current) return;
      try {
        setOpacity(await window.symbioteDesktop?.getOpacity() ?? opacity);
      } catch (readFailure) {
        console.error('Could not restore the Electron overlay opacity after an update failed:', readFailure);
      }
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
            {messages.map(message => <article className={`minimal-message minimal-message-${message.role}`} key={message.id}><span className={message.role === 'assistant' ? 'minimal-message-agent' : undefined}>{message.role === 'user' ? 'You' : <><AgentAvatar emoji={agentEmoji} image={agentAvatarDataUrl} size={13} />{agentName || 'Agent'}</>}</span>{message.content && <MessageBody content={message.content} />}{message.streaming && message.todoActivity?.length ? <TodoActivityBubble items={message.todoActivity} /> : null}{message.streaming && (() => {
              const activity = isAgentActivity(message.activityState) ? message.activityState : message.activeTool ? getToolActivity(message.activeTool).activity : 'thinking';
              const tool = message.activeTool ? getToolActivity(message.activeTool) : undefined;
              return <ReasoningDisplay activity={activity} toolLabel={tool ? `Executing · ${tool.label}` : undefined} compact />;
            })()}{message.interrupted && <small className="message-interrupted">This reply did not finish. Your message is preserved; you can try again.</small>}</article>)}
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
          <button type="button" className="minimal-opacity-toggle" onClick={() => setOpacityControlsOpen(open => !open)} aria-expanded={opacityControlsOpen} aria-controls="minimal-opacity-controls">
            <Gauge size={13} /><span>Opacity</span><strong>{Math.round(opacity * 100)}%</strong><ChevronDown size={12} />
          </button>
          {opacityControlsOpen && <div id="minimal-opacity-controls" className="minimal-opacity-controls">
            <input type="range" min="0.35" max="1" step="0.01" value={opacity} onChange={event => void updateOpacity(Number(event.target.value))} aria-label="Overlay opacity" />
          </div>}
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

function AgentAvatar({ emoji, image, size = 16, className = '' }: {
  emoji?: string;
  image?: string;
  size?: number;
  className?: string;
}) {
  return image
    ? <img className={className} src={image} alt="" width={size} height={size} />
    : <AgentGlyph id={emoji} className={className} size={size} />;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function uiText(value: unknown, maxLength = 240): string | null {
  return typeof value === 'string' && value.trim() && value.length <= maxLength ? value.trim() : null;
}

function SafeUiNode({ value, keyValue }: { value: unknown; keyValue: string }): ReactNode {
  if (!isRecord(value)) return null;
  const title = uiText(value.title, 120);
  const description = uiText(value.description, 500);
  if (value.type === 'card') {
    const children = Array.isArray(value.children) ? value.children.slice(0, 8) : [];
    return <section className="message-ui-card" key={keyValue}>
      {title && <h3>{title}</h3>}
      {description && <p>{description}</p>}
      {!!children.length && <div className="message-ui-children">{children.map((child, index) => <SafeUiNode key={index} keyValue={`${keyValue}-${index}`} value={child} />)}</div>}
    </section>;
  }
  if (value.type === 'metric') {
    const label = uiText(value.label, 80);
    const metric = typeof value.value === 'number' && Number.isFinite(value.value)
      ? String(value.value)
      : uiText(value.value, 100);
    const detail = uiText(value.detail, 160);
    if (!label || !metric) return null;
    return <div className="message-ui-metric" key={keyValue}><span>{label}</span><strong>{metric}</strong>{detail && <small>{detail}</small>}</div>;
  }
  if (value.type === 'progress') {
    const label = uiText(value.label, 80);
    if (!label || typeof value.value !== 'number' || !Number.isFinite(value.value)) return null;
    const percent = Math.max(0, Math.min(100, value.value));
    return <div className="message-ui-progress" key={keyValue}>
      <div><strong>{label}</strong><span>{Math.round(percent)}%</span></div>
      <progress max={100} value={percent} aria-label={`${label}: ${Math.round(percent)}%`} />
      {description && <small>{description}</small>}
    </div>;
  }
  if (value.type === 'steps') {
    const items = Array.isArray(value.items) ? value.items.slice(0, 10) : [];
    if (!items.length) return null;
    return <ol className="message-ui-steps" key={keyValue}>{items.map((item, index) => {
      if (!isRecord(item)) return null;
      const label = uiText(item.label, 160);
      if (!label) return null;
      const status = item.status === 'done' || item.status === 'active' ? item.status : 'pending';
      return <li className={`message-ui-step message-ui-step-${status}`} key={index}><span aria-hidden="true" />{label}</li>;
    })}</ol>;
  }
  if (value.type === 'link') {
    const label = uiText(value.label, 120);
    const target = uiText(value.url, 2_000);
    if (!label || !target) return null;
    try {
      const url = new URL(target);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
      return <a className="message-ui-link" href={url.toString()} target="_blank" rel="noopener noreferrer" key={keyValue}>{label}<ArrowUpRight size={13} /></a>;
    } catch {
      return null;
    }
  }
  return null;
}

function SafeUiBlock({ source }: { source: string }) {
  try {
    const value: unknown = JSON.parse(source);
    if (!isRecord(value) || !['card', 'metric', 'progress', 'steps', 'link'].includes(String(value.type))) {
      return <div className="message-ui-invalid" role="note">This interactive layout uses an unsupported component.</div>;
    }
    return <div className="message-ui-block"><SafeUiNode value={value} keyValue="root" /></div>;
  } catch {
    return <div className="message-ui-invalid" role="note">This interactive layout is incomplete or invalid.</div>;
  }
}

function MessageBody({ content }: { content: string }) {
  return (
    <div className="message-markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          table: ({ children }) => <div className="markdown-table-scroll"><table>{children}</table></div>,
          img: ({ src, alt }) => src ? <figure className="markdown-image"><img src={src} alt={alt ?? ''} loading="lazy" decoding="async" /><figcaption>{alt}</figcaption></figure> : null,
          pre: ({ children }) => <div className="message-code-block">{children}</div>,
          code: ({ className, children }) => className === 'language-symbiote-ui'
            ? <SafeUiBlock source={String(children).replace(/\n$/, '')} />
            : <code className={className}>{children}</code>,
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
          {checking ? <ActivityOrb label="Checking" compact loading /> : <ArrowRight size={15} />}
          {checking ? 'Checking…' : 'Connect'}
        </button>
      </form>
    </main>
  );
}

function CommandPalette({ query, onQuery, onClose, onNavigate, onNewSession, onRestartGateway, onChangeProviderModel, onCloneRepository, onReboot, isDesktopApp }: {
  query: string;
  onQuery: (value: string) => void;
  onClose: () => void;
  onNavigate: (view: ViewId) => void;
  onNewSession: () => void;
  onRestartGateway: () => void;
  onChangeProviderModel: () => void;
  onCloneRepository: () => void;
  onReboot: () => void;
  isDesktopApp: boolean;
}) {
  const commands = [
    ...NAVIGATION.map(item => ({ label: item.label, detail: `Open ${item.group.toLowerCase()}`, icon: item.icon, run: () => onNavigate(item.id) })),
    { label: 'New conversation', detail: 'Start a fresh session', icon: Plus, run: onNewSession },
    { label: 'Restart gateway', detail: 'Restart the supervised runtime', icon: RefreshCw, run: onRestartGateway },
    { label: 'Update provider & model', detail: 'Change the active model route', icon: Cpu, run: onChangeProviderModel },
    { label: 'Clone repository', detail: 'Clone an HTTPS repository into Projects', icon: FolderOpen, run: onCloneRepository },
    ...(isDesktopApp ? [{ label: 'Restart computer', detail: 'Requires confirmation and Windows approval', icon: Power, run: onReboot }] : []),
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

function CommandActionDialog({ action, config, onClose, onSubmit }: {
  action: 'provider-model' | 'clone-repository';
  config: GatewayConfig | null;
  onClose: () => void;
  onSubmit: (values: { provider: string; model: string } | { url: string }) => Promise<void>;
}) {
  const [provider, setProvider] = useState(config?.provider ?? '');
  const [model, setModel] = useState(config?.model ?? '');
  const [repositoryUrl, setRepositoryUrl] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const providers = [...new Set([...(config?.configuredProviders ?? []), ...(config?.provider ? [config.provider] : [])])];
  const title = action === 'provider-model' ? 'Update provider & model' : 'Clone repository';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setWorking(true);
    setError('');
    try {
      if (action === 'provider-model') await onSubmit({ provider, model });
      else await onSubmit({ url: repositoryUrl });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The command could not be completed.');
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="identity-backdrop" onMouseDown={onClose}>
      <section className="identity-dialog" role="dialog" aria-modal="true" aria-label={title} onMouseDown={event => event.stopPropagation()}>
        <header className="identity-dialog-header">
          <span className="identity-dialog-icon">{action === 'provider-model' ? <Cpu size={18} /> : <FolderOpen size={18} />}</span>
          <div><div className="eyebrow">COMMAND MENU</div><h2>{title}</h2></div>
          <button className="icon-button small" type="button" onClick={onClose} aria-label="Close"><X size={15} /></button>
        </header>
        <form onSubmit={event => void submit(event)}>
          {action === 'provider-model' ? <>
            <label className="identity-field">Provider
              <select value={provider} onChange={event => setProvider(event.target.value)} required>
                {providers.map(item => <option key={item} value={item}>{item}</option>)}
              </select>
            </label>
            <label className="identity-field">Model
              <input value={model} onChange={event => setModel(event.target.value)} maxLength={200} required />
              <small>The active provider and model are written to symbiote.json and applied by the gateway.</small>
            </label>
          </> : <>
            <label className="identity-field">HTTPS repository URL
              <input type="url" value={repositoryUrl} onChange={event => setRepositoryUrl(event.target.value)} placeholder="https://github.com/owner/repository.git" maxLength={2048} required />
              <small>Clones into a new registered project. Private repositories use your installed Git Credential Manager; credentials in URLs are rejected.</small>
            </label>
          </>}
          {error && <div className="notice notice-error" role="alert">{error}</div>}
          <div className="identity-dialog-actions">
            <button className="button button-secondary" type="button" onClick={onClose} disabled={working}>Cancel</button>
            <button className="button button-primary" type="submit" disabled={working || (action === 'provider-model' && providers.length === 0)}>
              {working ? <ActivityOrb label="Working" compact loading /> : action === 'provider-model' ? <Check size={14} /> : <FolderOpen size={14} />}
              {working ? 'Working…' : action === 'provider-model' ? 'Apply route' : 'Clone repository'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

export default function App() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [appearance, setAppearance] = useState<AppearanceSettings>(initialAppearance);

  const [resolvedProjectIds, setResolvedProjectIds] = useState<Set<string>>(() => new Set());

  const handleSendAgentResponse = useCallback(async (agentId: string, response: string) => {
    if (!response.trim()) return;
    try {
      await api(`/api/agents/${encodeURIComponent(agentId)}/action`, {
        method: 'POST',
        body: JSON.stringify({ action: 'steer', message: response.trim() }),
      });
    } catch (error) {
      console.error('Failed to send agent response:', error);
      throw error;
    }
  }, []);
  const appearanceReadyRef = useRef(false);
  const appearanceDirtyRef = useRef(false);
  const appearanceRevisionRef = useRef(0);
  const appearanceRef = useRef(appearance);
  const appearanceSyncErrorRef = useRef(false);
  appearanceRef.current = appearance;
  const changeAppearance = (next: AppearanceSettings) => {
    appearanceRevisionRef.current++;
    appearanceDirtyRef.current = true;
    appearanceRef.current = next;
    setAppearance(next);
  };
  const isMinimalMode = new URLSearchParams(window.location.search).get('minimal') === '1';
  const isDesktopApp = new URLSearchParams(window.location.search).get('desktop') === '1' && Boolean(window.symbioteDesktop);
  const [view, setView] = useState<ViewId>('workspace');
  const [refreshIntervalMs, setRefreshIntervalMs] = useState(readRefreshInterval);
  const [threadToOpen, setThreadToOpen] = useState('');
  const [googleWorkspaceGrant, setGoogleWorkspaceGrant] = useState<GoogleWorkspaceGrant | null>(null);
  const [cloudProviderStatus, setCloudProviderStatus] = useState<CloudProviderStatus>({
    azure: false, oci: false, n8n: false, kaggle: false,
  });
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [dismissedUpdateVersion, setDismissedUpdateVersion] = useState<string | null>(null);
  const [preparingUpdate, setPreparingUpdate] = useState(false);
  const [config, setConfig] = useState<GatewayConfig | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [projects, setProjects] = useState<WorkspaceProject[]>([]);
  const [workspaceAgents, setWorkspaceAgents] = useState<AgentProfile[]>([]);
  const [workspaceProjectId, setWorkspaceProjectId] = useState('');
  const [workspaceAgentId, setWorkspaceAgentId] = useState('');
  const [tools, setTools] = useState<ToolSummary[]>([]);
  const [runs, setRuns] = useState<WorkspaceRun[]>([]);
  const [agents, setAgents] = useState<WorkspaceAgent[]>([]);
  const [threadHelpRequests, setThreadHelpRequests] = useState<ThreadUserHelpRequest[]>([]);
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
  const [toolQuery, setToolQuery] = useState('');
  const [logQuery, setLogQuery] = useState('');
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const [commandAction, setCommandAction] = useState<'provider-model' | 'clone-repository' | null>(null);
  const [commandNotice, setCommandNotice] = useState('');
  const [identityOpen, setIdentityOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [relativeTimeNow, setRelativeTimeNow] = useState(Date.now());
  const [clearedNotificationIds, setClearedNotificationIds] = useState<string[]>(() => {
    try {
      const stored = window.localStorage.getItem('symbiote-cleared-notifications');
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
  const [recentThreadsOpen, setRecentThreadsOpen] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const statusRequest = useRef<Promise<void> | null>(null);
  const activeTurnSessionId = useRef<string | null>(null);
  const nativeNotifiedIds = useRef(new Set<string>());
  const toolSearchRef = useRef<HTMLInputElement>(null);
  const logSearchRef = useRef<HTMLInputElement>(null);
  const activeSession = sessions.find(session => session.id === activeSessionId);
  const activeProfile = activeSession?.agentId ? workspaceAgents.find(profile => profile.id === activeSession.agentId) : undefined;
  const currentNavigation = NAVIGATION.find(item => item.id === view) ?? NAVIGATION[0];
  const contextSessions = useMemo(() => sessions.filter(session => {
    if (workspaceAgentId) return session.agentId === workspaceAgentId;
    if (workspaceProjectId) return session.projectId === workspaceProjectId;
    return true;
  }), [sessions, workspaceAgentId, workspaceProjectId]);
  const contextSessionIds = useMemo(() => new Set(contextSessions.map(session => session.id)), [contextSessions]);
  const contextRuns = useMemo(() => workspaceAgentId || workspaceProjectId
    ? runs.filter(run => contextSessionIds.has(run.sessionId))
    : runs, [runs, contextSessionIds, workspaceAgentId, workspaceProjectId]);
  const contextAgents = useMemo(() => workspaceAgentId || workspaceProjectId
    ? agents.filter(agent => workspaceAgentId ? agent.agentId === workspaceAgentId : agent.projectId === workspaceProjectId)
    : agents, [agents, workspaceAgentId, workspaceProjectId]);
  const heroActivity = useMemo<AgentActivity>(() => {
    const liveMessage = messages.slice().reverse().find(message => message.role === 'assistant' && message.streaming);
    if (liveMessage?.activeTool) return getToolActivity(liveMessage.activeTool).activity;
    if (isAgentActivity(liveMessage?.activityState)) return liveMessage.activityState;
    const activeRun = runs.filter(run => run.status === 'running').sort((left, right) => right.startedAt - left.startedAt)[0];
    if (activeRun?.activeTool) return getToolActivity(activeRun.activeTool).activity;
    if (activeRun?.activity) return getActivityFromStatus(activeRun.activity);
    return status?.activeTurns ? 'thinking' : 'listening';
  }, [messages, runs, status?.activeTurns]);
  const googleWorkspaceOnline = Boolean(googleWorkspaceGrant && googleWorkspaceGrant.expiresAt > Date.now());
  const cloudIntegrations: Array<{ id: string; label: string; online: boolean; view: ViewId; icon: ReactNode }> = [
    { id: 'google-workspace', label: 'Google Workspace', online: googleWorkspaceOnline, view: 'integrations', icon: <GoogleWorkspaceMark /> },
    { id: 'azure', label: 'Microsoft Azure', online: cloudProviderStatus.azure, view: 'integrations', icon: <Cloud /> },
    { id: 'oci', label: 'Oracle Cloud Infrastructure', online: cloudProviderStatus.oci, view: 'integrations', icon: <Database /> },
    { id: 'n8n', label: 'n8n Cloud', online: cloudProviderStatus.n8n, view: 'integrations', icon: <Workflow /> },
    { id: 'kaggle', label: 'Kaggle', online: cloudProviderStatus.kaggle, view: 'integrations', icon: <Cpu /> },
  ];
  const sessionDraft = sessionDrafts[activeSessionId] ?? '';

  useEffect(() => {
    let cancelled = false;
    const synchronize = async () => {
      try {
        const state = await api<{ settings: unknown; initialized: boolean }>('/api/appearance');
        const remote = parseAppearanceSettings(state.settings);
        if (!remote) throw new Error('Gateway returned invalid appearance settings.');
        if (cancelled) return;
        const wasReady = appearanceReadyRef.current;
        appearanceReadyRef.current = true;
        appearanceSyncErrorRef.current = false;
        if (appearanceDirtyRef.current) {
          const revision = appearanceRevisionRef.current;
          await api('/api/appearance', { method: 'PUT', body: JSON.stringify(appearanceRef.current) });
          if (appearanceRevisionRef.current === revision) appearanceDirtyRef.current = false;
        } else if (!wasReady && !state.initialized) {
          appearanceDirtyRef.current = true;
          const revision = ++appearanceRevisionRef.current;
          await api('/api/appearance', { method: 'PUT', body: JSON.stringify(appearanceRef.current) });
          if (appearanceRevisionRef.current === revision) appearanceDirtyRef.current = false;
        } else if (!wasReady
          || remote.brightness !== appearanceRef.current.brightness
          || remote.primaryHue !== appearanceRef.current.primaryHue
            || remote.secondaryHue !== appearanceRef.current.secondaryHue) {
          appearanceRef.current = remote;
          setAppearance(remote);
        }
      } catch (failure) {
        if (!appearanceSyncErrorRef.current) {
          console.error('Could not synchronize shared appearance settings with the Gateway:', failure);
          appearanceSyncErrorRef.current = true;
        }
      }
    };
    void synchronize();
    const timer = window.setInterval(() => void synchronize(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!appearanceReadyRef.current || !appearanceDirtyRef.current) return;
    const revision = appearanceRevisionRef.current;
    const timer = window.setTimeout(() => {
      void api('/api/appearance', { method: 'PUT', body: JSON.stringify(appearance) })
        .then(() => {
          appearanceSyncErrorRef.current = false;
          if (appearanceRevisionRef.current === revision) appearanceDirtyRef.current = false;
        })
        .catch(failure => {
          if (!appearanceSyncErrorRef.current) {
            console.error('Could not save shared appearance settings to the Gateway:', failure);
            appearanceSyncErrorRef.current = true;
          }
        });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [appearance]);

  useEffect(() => {
    const nextTheme: Theme = appearance.brightness >= 50 ? 'light' : 'dark';
    setTheme(nextTheme);
    const root = document.documentElement;
    const brightness = appearance.brightness;
    const primaryLightness = brightness >= 50
      ? 68 + (brightness - 50) * 0.34
      : 27 + brightness * 0.2;
    const primary = `hsl(${appearance.primaryHue} 32% ${primaryLightness}%)`;
    const primaryInk = contrastInk(hslRgb(appearance.primaryHue, 32, primaryLightness));
    const paperInk = contrastInk(hslRgb(0, 0, brightness));
    const highlightLightness = brightness;
    const highlightInk = contrastInk(hslRgb(0, 0, highlightLightness));
    const iconLightness = 69 - brightness * 0.31;
    const iconInk = contrastInk(hslRgb(appearance.secondaryHue, 72, iconLightness));
    root.style.setProperty('--appearance-brightness', `${brightness}%`);
    root.style.setProperty('--appearance-primary', primary);
    root.style.setProperty('--appearance-primary-hue', `${appearance.primaryHue}deg`);
    root.style.setProperty('--appearance-primary-ink', primaryInk);
    root.style.setProperty('--appearance-icon', `hsl(${appearance.secondaryHue} 72% ${iconLightness}%)`);
    root.style.setProperty('--appearance-icon-ink', iconInk);
    root.style.setProperty('--appearance-highlight', `hsl(0 0% ${highlightLightness}%)`);
    root.style.setProperty('--appearance-highlight-hover', `hsl(0 0% ${Math.max(0, brightness - 8)}%)`);
    root.style.setProperty('--appearance-paper-ink', paperInk);
    root.style.setProperty('--appearance-paper-ink-soft', `color-mix(in srgb, ${paperInk} 90%, hsl(0 0% ${brightness}%) 10%)`);
    root.style.setProperty('--appearance-paper-ink-muted', `color-mix(in srgb, ${paperInk} 82%, hsl(0 0% ${brightness}%) 18%)`);
    root.style.setProperty('--ink', 'var(--appearance-paper-ink)');
    root.style.setProperty('--ink-soft', 'var(--appearance-paper-ink-soft)');
    root.style.setProperty('--ink-muted', 'var(--appearance-paper-ink-muted)');
    root.style.setProperty('--appearance-sidebar-ink', primaryInk);
    root.style.setProperty('--appearance-highlight-ink', highlightInk);
    root.style.setProperty('--appearance-sidebar-muted', `color-mix(in srgb, ${primaryInk} 84%, ${primary} 16%)`);
    root.style.setProperty('--appearance-sidebar-line', `color-mix(in srgb, ${primaryInk} 24%, transparent)`);
    try {
      window.localStorage.setItem('symbiote-appearance', JSON.stringify(appearance));
    } catch {
      // Appearance still updates for this page when persistence is unavailable.
    }
  }, [appearance]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.title = 'Control Room';
    const primary = getComputedStyle(document.documentElement).getPropertyValue('--appearance-primary').trim();
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', primary || (theme === 'dark' ? '#080808' : '#f4f4f4'));
    if (window.symbioteDesktop) {
      void window.symbioteDesktop.setTheme(theme).catch(failure => {
        console.error('Could not synchronize the Electron window theme:', failure);
      });
    }
    try {
      window.localStorage.setItem('symbiote-theme', theme);
    } catch {
      // The current page theme still works when persistent storage is unavailable.
    }
  }, [theme]);

  useEffect(() => {
    if (!googleWorkspaceGrant) return;
    const timer = window.setTimeout(() => setGoogleWorkspaceGrant(null), Math.max(0, googleWorkspaceGrant.expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [googleWorkspaceGrant]);

  useEffect(() => {
    const timer = window.setInterval(() => setRelativeTimeNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem('symbiote-cleared-notifications', JSON.stringify(clearedNotificationIds.slice(-200)));
    } catch {
      // The current notification state remains available for this page lifetime.
    }
  }, [clearedNotificationIds]);

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
        const search = view === 'tools' ? toolSearchRef.current : view === 'operations' ? logSearchRef.current : null;
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

  const refreshStatus = useCallback((): Promise<void> => {
    if (statusRequest.current) return statusRequest.current;
    const request = api<GatewayStatus>('/api/status')
      .then(fresh => {
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
      })
      .catch(failure => {
        setGatewayConnected(false);
        throw failure;
      })
      .finally(() => {
        statusRequest.current = null;
      });
    statusRequest.current = request;
    return request;
  }, []);

  const installUpdate = async () => {
    if (!window.symbioteDesktop || preparingUpdate) return;
    setPreparingUpdate(true);
    setError('');
    try {
      await api('/api/update/download', { method: 'POST', body: '{}' });
      const started = await window.symbioteDesktop.installUpdate();
      if (!started) throw new Error('Update installation was cancelled or could not be started.');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not prepare the verified update installer.');
      setPreparingUpdate(false);
    }
  };

  const refreshWork = useCallback(async () => {
    const [freshRuns, freshAgents] = await Promise.all([
      api<WorkspaceRun[]>('/api/runs'),
      api<WorkspaceAgent[]>('/api/agents'),
    ]);
    setRuns(freshRuns);
    setAgents(freshAgents);
  }, []);

  const lighting = useMemo<AgentLightingState>(() => {
    const agentActiveNodes = new Set<string>();
    const agentResponseNodes = new Map<string, string>();
    const agentsByProject = new Map<string, WorkspaceAgent[]>();
    for (const agent of agents) {
      const isWorking = Boolean(agent.activeTool) || agent.operations?.some(operation => operation.status === 'running') === true;
      if (isWorking) agentActiveNodes.add(agent.sessionId);
      else if (agent.status === 'running') agentResponseNodes.set(agent.sessionId, agent.sessionId);
      if (agent.projectId) {
        const projectAgents = agentsByProject.get(agent.projectId) ?? [];
        projectAgents.push(agent);
        agentsByProject.set(agent.projectId, projectAgents);
      }
    }
    const projectPendingNodes = new Map<string, string>();
    for (const project of projects) {
      const projectAgents = agentsByProject.get(project.id) ?? [];
      const completedAgents = projectAgents.filter(agent => agent.status === 'completed');
      if (!completedAgents.length || projectAgents.some(agent => agent.status === 'running')) continue;
      const completionKey = `${project.id}:${Math.max(...completedAgents.map(agent => agent.completedAt ?? agent.startedAt))}`;
      if (!resolvedProjectIds.has(completionKey)) projectPendingNodes.set(`project:${project.id}`, completionKey);
    }
    return { agentActiveNodes, projectPendingNodes, agentResponseNodes };
  }, [agents, projects, resolvedProjectIds]);

  const resolveProject = useCallback((completionKey: string) => {
    setResolvedProjectIds(previous => new Set(previous).add(completionKey));
  }, []);



  const refreshAll = useCallback(async (showSpinner = false) => {
    if (showSpinner) setRefreshing(true);
    setError('');
    const results = await Promise.allSettled([
      refreshStatus(),
      api<GatewayConfig>('/api/config').then(setConfig),
      api<{ providers: CloudProviderStatus }>('/api/integrations').then(result => setCloudProviderStatus(result.providers)),
      api<WorkspaceProject[]>('/api/projects').then(data => {
        setProjects(data);
        setWorkspaceProjectId(current => current && data.some(item => item.id === current) ? current : '');
      }),
      api<AgentProfile[]>('/api/workspace-agents').then(setWorkspaceAgents),
      api<SessionSummary[]>('/api/sessions').then(data => {
        setSessions(data);
        setActiveSessionId(current => current && data.some(item => item.id === current) ? current : data[0]?.id ?? '');
      }),
      api<ToolSummary[]>('/api/tools').then(setTools),
      refreshWork(),
    ]);
    const firstError = results.find(result => result.status === 'rejected'
      && !(result.reason instanceof TypeError)
      && !(result.reason instanceof Error && /failed to fetch|networkerror|load failed/i.test(result.reason.message)));
    if (firstError?.status === 'rejected') setError(firstError.reason instanceof Error ? firstError.reason.message : 'Could not load gateway data.');
    setLoading(false);
    if (showSpinner) setRefreshing(false);
  }, [refreshStatus, refreshWork]);

  const runCommandAction = async (values: { provider: string; model: string } | { url: string }) => {
    if ('provider' in values) {
      await api('/api/config/provider-model', { method: 'POST', body: JSON.stringify(values) });
      setCommandNotice(`Active provider and model updated to ${values.provider}/${values.model}.`);
    } else {
      const project = await api<WorkspaceProject>('/api/projects/clone', { method: 'POST', body: JSON.stringify(values) });
      setCommandNotice(`Repository cloned into project “${project.name}”.`);
    }
    setCommandAction(null);
    setError('');
    void refreshAll(true);
    window.setTimeout(() => setCommandNotice(''), 7000);
  };

  const restartGateway = async () => {
    if (!window.confirm('Restart the Symbiote Gateway? Active sessions may be interrupted briefly.')) return;
    try {
      await api('/api/gateway/restart', { method: 'POST', body: '{}' });
      setError('');
      setCommandNotice('Gateway restart requested. Electron will supervise the restart.');
      window.setTimeout(() => setCommandNotice(''), 7000);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Gateway restart could not be requested.');
    }
  };

  const restartChannel = async (channelType: string) => {
    if (!window.confirm(`Restart the Gateway and ${channelType} adapter? Other connections will briefly reconnect too.`)) return;
    try {
      await api('/api/gateway/restart', { method: 'POST', body: '{}' });
      setCommandNotice(`${channelType} restart requested.`);
      window.setTimeout(() => setCommandNotice(''), 7000);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : `${channelType} could not be restarted.`);
    }
  };

  const clearHealthIncidents = async () => {
    try {
      const result = await api<{ archived: number }>('/api/health/incidents/archive', { method: 'POST', body: '{}' });
      await refreshStatus();
      setCommandNotice(`${result.archived} incident${result.archived === 1 ? '' : 's'} archived.`);
      window.setTimeout(() => setCommandNotice(''), 7000);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Incidents could not be archived.');
    }
  };

  const rebootComputer = async () => {
    if (!window.symbioteDesktop || !window.confirm('Restart this computer? Windows will ask for approval, then restart in 15 seconds.')) return;
    try {
      await window.symbioteDesktop.requestReboot();
      setCommandNotice('Windows accepted the restart request. You can cancel it with “shutdown /a” before the countdown ends.');
      window.setTimeout(() => setCommandNotice(''), 7000);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Computer restart was not started.');
    }
  };

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
    let retryDelay = 1000;
    let retryTimer: number | undefined;
    const checkAccess = async () => {
      try {
        const access = await api<{ required: boolean; authenticated: boolean }>('/api/access');
        if (cancelled) return;
        setAccessRequired(access.required);
        setAccessGranted(access.authenticated);
        setAccessChecked(true);
        if (access.authenticated) void refreshAll();
        else setLoading(false);
      } catch (failure) {
        if (cancelled) return;
        setAccessChecked(true);
        setLoading(false);
        const reason = failure instanceof Error ? failure.message : 'Could not check LAN access.';
        setError(`${reason} Reconnecting…`);
        retryTimer = window.setTimeout(() => void checkAccess(), retryDelay);
        retryDelay = Math.min(retryDelay * 2, 15_000);
      }
    };
    void checkAccess();
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [refreshAll]);

  useEffect(() => {
    if (!accessGranted) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        await refreshStatus();
      } catch {
        // refreshStatus updates the connection indicator and errors are retried on the next tick.
      }
      if (view === 'workspace' || view === 'runs' || view === 'agents' || view === 'projects') {
        try {
          await refreshWork();
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : 'Could not refresh workspace activity.');
        }
      }
      if (view === 'operations') {
        try {
          const result = await api<{ lines: string }>('/api/logs?lines=120');
          setLogLines(result.lines);
        } catch {
          // The next scheduled poll retries log retrieval.
        }
      }
      if (!cancelled) timer = window.setTimeout(poll, refreshIntervalMs);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [accessGranted, refreshIntervalMs, refreshStatus, refreshWork, view]);

  useEffect(() => {
    try {
      window.localStorage.setItem(REFRESH_INTERVAL_KEY, String(refreshIntervalMs));
    } catch {
      setError('The telemetry refresh interval could not be saved in this browser.');
    }
  }, [refreshIntervalMs]);

  useEffect(() => {
    if (!accessGranted) {
      setThreadHelpRequests([]);
      return;
    }
    let cancelled = false;
    const refreshHelpRequests = () => {
      void api<ThreadUserHelpRequest[]>('/api/threads/requests')
        .then(requests => { if (!cancelled) setThreadHelpRequests(requests); })
        .catch(failure => { if (!cancelled) setError(failure instanceof Error ? failure.message : 'Agent help requests could not be loaded.'); });
    };
    refreshHelpRequests();
    const timer = window.setInterval(refreshHelpRequests, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [accessGranted]);

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
        body: JSON.stringify({
          name: 'New conversation',
          ...(workspaceProjectId ? { projectId: workspaceProjectId } : {}),
          ...(workspaceAgentId ? { agentId: workspaceAgentId } : {}),
        }),
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
        body: JSON.stringify({
          prompt,
          sessionId,
          ...(googleWorkspaceOnline && googleWorkspaceGrant ? { googleWorkspaceAccessToken: googleWorkspaceGrant.accessToken } : {}),
        }),
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

  const runProjectTask = async (projectId: string, prompt: string, agentId?: string): Promise<boolean> => {
    setError('');
    try {
      const created = await api<{ id: string }>('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({ name: 'IDE project task', projectId, ...(agentId ? { agentId } : {}) }),
      });
      await refreshAll();
      return await launchRun(prompt, created.id);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not start the project task.');
      return false;
    }
  };

  const archiveProject = async (projectId: string): Promise<boolean> => {
    if (!window.confirm('Archive this project and all of its conversations, agents, and subagents? The workspace files will be retained.')) return false;
    try {
      await api(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' });
      await refreshAll();
      if (workspaceProjectId === projectId) {
        setWorkspaceProjectId('');
        setWorkspaceAgentId('');
        setActiveSessionId('');
      }
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Project could not be archived.');
      return false;
    }
  };

  const restoreProject = async (projectId: string): Promise<void> => {
    try {
      await api(`/api/projects/${encodeURIComponent(projectId)}/restore`, { method: 'POST' });
      await refreshAll();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Project could not be restored.');
      throw failure;
    }
  };

  const updateProject = (updated: WorkspaceProject) => {
    setProjects(current => current.map(project => project.id === updated.id ? updated : project));
  };

  const permanentlyDeleteProject = async (projectId: string, projectName: string): Promise<boolean> => {
    if (!window.confirm(`Permanently delete ${projectName} and all of its archived workspace files and sessions? This cannot be undone.`)) return false;
    try {
      await api(`/api/projects/${encodeURIComponent(projectId)}/permanent`, { method: 'DELETE' });
      await refreshAll();
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Archived project could not be deleted.');
      return false;
    }
  };

  const openProjectDetails = (projectId: string) => {
    setWorkspaceProjectId(projectId);
    setWorkspaceAgentId('');
    navigate('projects');
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

  const archiveRun = async (id: string) => {
    try {
      await api(`/api/runs/${encodeURIComponent(id)}/archive`, { method: 'POST' });
      await refreshWork();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not archive the run.');
    }
  };

  const restoreRun = async (id: string) => {
    try {
      await api(`/api/runs/${encodeURIComponent(id)}/restore`, { method: 'POST' });
      await refreshWork();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not restore the run.');
    }
  };

  const updateIdentity = async (identity: { name: string; emoji: string; soulContent: string; agentsContent: string; instructions: string; avatarDataUrl: string | null }) => {
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

  const selectSession = (sessionId: string) => {
    const session = sessions.find(item => item.id === sessionId);
    const subagent = agents.find(item => item.sessionId === sessionId);
    setWorkspaceProjectId(session?.projectId ?? subagent?.projectId ?? '');
    setWorkspaceAgentId(session?.agentId ?? subagent?.agentId ?? '');
    setActiveSessionId(sessionId);
  };

  const openRunSession = (sessionId: string) => {
    selectSession(sessionId);
    navigate('chat');
  };

  const openProfileConversation = async (profile: AgentProfile) => {
    try {
      const savedConversation = sessions
        .filter(session => session.projectId === profile.projectId && session.agentId === profile.id && session.sessionKind !== 'subagent')
        .sort((left, right) => right.updatedAt - left.updatedAt)[0];
      if (savedConversation) {
        setWorkspaceProjectId(profile.projectId);
        setWorkspaceAgentId(profile.id);
        setActiveSessionId(savedConversation.id);
        navigate('chat');
        return;
      }
      const created = await api<{ id: string }>('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({ name: `${profile.name} conversation`, projectId: profile.projectId, agentId: profile.id }),
      });
      setActiveSessionId(created.id);
      await refreshAll();
      navigate('chat');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not open the agent conversation.');
    }
  };

  const openSubagentConversation = (sessionId: string) => {
    const subagent = agents.find(agent => agent.sessionId === sessionId);
    setWorkspaceProjectId(subagent?.projectId ?? '');
    setWorkspaceAgentId(subagent?.agentId ?? '');
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
        if (!remaining.length) navigate('workspace');
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not archive conversation.');
    }
  };

  const createProject = async (name: string, scope = '') => {
    const created = await api<WorkspaceProject>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name, scope }),
    });
    setProjects(current => [...current, created]);
    setWorkspaceProjectId(created.id);
  };

  const createWorkspaceAgent = async (profile: { projectId: string; name: string; emoji: string; instructions: string }) => {
    const created = await api<AgentProfile>('/api/workspace-agents', {
      method: 'POST',
      body: JSON.stringify(profile),
    });
    setWorkspaceAgents(current => [...current, created]);
    setWorkspaceProjectId(created.projectId);
    setWorkspaceAgentId(created.id);
  };

  const sendMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = sessionDraft.trim();
    if (!text || !activeSessionId || sending) return;
    const userMessage: ChatMessage = { id: createClientId(), role: 'user', content: text, timestamp: Date.now(), tokensIn: Math.ceil(text.length / 4), tokenCountsEstimated: true };
    const assistantId = createClientId();
    let streamedText = '';
    activeTurnSessionId.current = activeSessionId;
    setMessages(previous => [...previous, userMessage, { id: assistantId, role: 'assistant', content: '', timestamp: Date.now(), streaming: true, thinking: true, activityState: 'thinking' }]);
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
        inputTokens?: number;
        outputTokens?: number;
        toolCalls?: Array<{ name: string; input: Record<string, unknown>; result: string }>;
      }>('/api/chat', {
        text,
        sessionId: activeSessionId,
        ...(googleWorkspaceOnline && googleWorkspaceGrant ? { googleWorkspaceAccessToken: googleWorkspaceGrant.accessToken } : {}),
      }, streamed => {
        if (streamed.type === 'todo_update') {
          setMessages(previous => previous.map(message => message.id === assistantId
            ? { ...message, todoActivity: mergeTodoActivity(message.todoActivity, streamed.completedTodo, streamed.remainingTodos) }
            : message));
          return;
        }
        setMessages(previous => previous.map(message => {
          if (message.id !== assistantId) return message;
          if (streamed.type === 'text_delta') {
            const delta = String(streamed.text ?? '');
            streamedText += delta;
            return { ...message, content: message.content + delta, thinking: false, activityState: 'responding' };
          }
          if (streamed.type === 'thinking_delta') return { ...message, thinking: true, activityState: 'reasoning' };
          if (streamed.type === 'tool_start') {
            const name = String(streamed.name ?? 'tool');
            return {
              ...message,
              thinking: false,
              activityState: getToolActivity(name).activity,
              activeTool: name,
              activeTools: [...(message.activeTools ?? []), name],
              toolActivity: [...(message.toolActivity ?? []), { name, status: 'running' as const }],
            };
          }
          if (streamed.type === 'tool_end') {
            const name = String(streamed.name ?? 'tool');
            const toolActivity = [...(message.toolActivity ?? [])];
            let runningIndex = -1;
            for (let index = toolActivity.length - 1; index >= 0; index--) {
              if (toolActivity[index].name === name && toolActivity[index].status === 'running') {
                runningIndex = index;
                break;
              }
            }
            if (runningIndex >= 0) toolActivity[runningIndex] = { ...toolActivity[runningIndex], status: 'done' };
            const activeTools = toolActivity.filter(tool => tool.status === 'running').map(tool => tool.name);
            return { ...message, activeTools, activeTool: activeTools.at(-1), toolActivity, thinking: activeTools.length === 0, activityState: activeTools.length ? getToolActivity(activeTools.at(-1)!).activity : 'thinking' };
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
            activeTool: undefined,
            toolActivity: [],
            todoActivity: [],
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
        activeTool: undefined,
        toolActivity: [],
        todoActivity: [],
        timestamp: Date.now(),
        durationMs: response.durationMs,
        iterations: response.iterations,
        tokensIn: response.inputTokens,
        tokensOut: response.outputTokens,
        tokenCountsEstimated: response.outputTokens === undefined,
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
        activeTool: undefined,
        toolActivity: [],
        todoActivity: [],
        interrupted: true,
      } : message));
    } finally {
      activeTurnSessionId.current = null;
      setSending(false);
    }
  };

  const sendMemoryNode = async (context: MemoryNodeContext, question: string) => {
    if (sending || activeTurnSessionId.current) throw new Error('Wait for the current agent turn to finish before sending memory context.');
    const label = `Memory · ${context.selected.label.replace(/\s+/g, ' ').trim().slice(0, 64)}`;
    const session = await api<SessionSummary>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: label }),
    });
    const text = `${question}\n\nUse this selected memory node and its locally computed graph analytics as context. The similarity values are exact VDB TF–IDF cosine scores; no additional graph analysis is needed:\n\n${JSON.stringify(context, null, 2)}`;
    const userMessage: ChatMessage = { id: createClientId(), role: 'user', content: text, timestamp: Date.now(), tokensIn: Math.ceil(text.length / 4), tokenCountsEstimated: true };
    const assistantId = createClientId();
    let streamedText = '';
    setSessions(previous => [session, ...previous.filter(item => item.id !== session.id)]);
    setActiveSessionId(session.id);
    setMessages([userMessage, { id: assistantId, role: 'assistant', content: '', timestamp: Date.now(), streaming: true, thinking: true, activityState: 'thinking' }]);
    navigate('chat');
    activeTurnSessionId.current = session.id;
    setSending(true);
    setError('');
    try {
      const outcome = await streamApi<{
        text: string;
        durationMs?: number;
        iterations?: number;
        inputTokens?: number;
        outputTokens?: number;
        toolCalls?: Array<{ name: string; input: Record<string, unknown>; result: string }>;
      }>('/api/chat', { text, sessionId: session.id }, streamed => {
        if (streamed.type === 'text_delta') {
          const delta = String(streamed.text ?? '');
          streamedText += delta;
          setMessages(previous => previous.map(message => message.id === assistantId
            ? { ...message, content: message.content + delta, thinking: false, activityState: 'responding' }
            : message));
        } else if (streamed.type === 'thinking_delta') {
          setMessages(previous => previous.map(message => message.id === assistantId ? { ...message, thinking: true, activityState: 'reasoning' } : message));
        } else if (streamed.type === 'tool_start') {
          const name = String(streamed.name ?? 'tool');
          setMessages(previous => previous.map(message => message.id === assistantId ? {
            ...message,
            thinking: false,
            activityState: getToolActivity(name).activity,
            activeTool: name,
            activeTools: [...(message.activeTools ?? []), name],
            toolActivity: [...(message.toolActivity ?? []), { name, status: 'running' as const }],
          } : message));
        } else if (streamed.type === 'tool_end') {
          const name = String(streamed.name ?? 'tool');
          setMessages(previous => previous.map(message => {
            if (message.id !== assistantId) return message;
            const toolActivity = [...(message.toolActivity ?? [])];
            let runningIndex = -1;
            for (let index = toolActivity.length - 1; index >= 0; index--) {
              if (toolActivity[index].name === name && toolActivity[index].status === 'running') {
                runningIndex = index;
                break;
              }
            }
            if (runningIndex >= 0) toolActivity[runningIndex] = { ...toolActivity[runningIndex], status: 'done' };
            const activeTools = toolActivity.filter(tool => tool.status === 'running').map(tool => tool.name);
            const activeTool = activeTools[activeTools.length - 1];
            return { ...message, activeTools, activeTool, toolActivity, thinking: activeTools.length === 0, activityState: activeTool ? getToolActivity(activeTool).activity : 'thinking' };
          }));
        }
      });
      if (!outcome.complete) {
        const savedMessages = await api<ChatMessage[]>(`/api/sessions/${encodeURIComponent(session.id)}/messages`);
        setMessages(savedMessages);
        if (!savedMessages.some(message => message.role === 'assistant' && message.content)) {
          throw new Error('The memory conversation ended before the agent completed its response.');
        }
      } else {
        const savedMessages = await api<ChatMessage[]>(`/api/sessions/${encodeURIComponent(session.id)}/messages`);
        const response = outcome.result;
        setMessages(savedMessages.length ? savedMessages : [userMessage, {
          id: assistantId,
          role: 'assistant',
          content: response.text || streamedText || 'The turn completed without a text response.',
          timestamp: Date.now(),
          streaming: false,
          thinking: false,
          durationMs: response.durationMs,
          iterations: response.iterations,
          tokensIn: response.inputTokens,
          tokensOut: response.outputTokens,
          tokenCountsEstimated: response.outputTokens === undefined,
          toolCalls: response.toolCalls ?? [],
        }]);
      }
      const savedSessions = await api<SessionSummary[]>('/api/sessions');
      setSessions(savedSessions);
      void refreshStatus().catch(() => undefined);
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : 'The memory conversation failed.';
      setError(message);
      setMessages(previous => previous.map(item => item.id === assistantId ? {
        ...item,
        content: item.content || streamedText || message,
        streaming: false,
        thinking: false,
        interrupted: true,
        activeTools: [],
        activeTool: undefined,
        toolActivity: [],
      } : item));
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

  const activeChannelList = status?.channels ?? [];
  const channelList = activeChannelList.some(channel => channel.channelType === 'whatsapp')
    ? activeChannelList
    : [...activeChannelList, { id: 'whatsapp-main', channelType: 'whatsapp', status: 'not-configured' }];
  const isOnline = gatewayConnected;
  const attentionItems = [
    ...runs.filter(run => !run.archivedAt && run.status === 'failed').map(run => ({
      id: `run-${run.id}-${run.completedAt ?? run.startedAt}`,
      title: run.name,
      detail: run.error || 'The task stopped unexpectedly.',
      timestamp: run.completedAt ?? run.startedAt,
      severity: 3,
      destination: 'runs' as ViewId,
      targetId: `run-item-${run.id}`,
    })),
    ...agents.filter(agent => agent.status === 'failed').map(agent => ({
      id: `agent-${agent.sessionId}-${agent.completedAt ?? agent.startedAt}`,
      title: agent.task,
      detail: agent.error || 'The subagent failed.',
      timestamp: agent.completedAt ?? agent.startedAt,
      severity: 3,
      destination: 'agents' as ViewId,
      targetId: `agent-item-${agent.sessionId}`,
    })),
    ...runs.filter(run => !run.archivedAt && run.status === 'cancelled').map(run => ({
      id: `run-${run.id}-${run.completedAt ?? run.startedAt}`,
      title: run.name,
      detail: 'The task was stopped before completion.',
      timestamp: run.completedAt ?? run.startedAt,
      severity: 2,
      destination: 'runs' as ViewId,
      targetId: `run-item-${run.id}`,
    })),
    ...(!isOnline ? [{
      id: 'gateway-offline',
      title: 'Gateway connection lost',
      detail: 'The control room cannot reach the local runtime.',
      timestamp: relativeTimeNow,
      severity: 4,
      destination: 'operations' as ViewId,
      targetId: 'health-incidents',
    }] : []),
  ].sort((left, right) => right.severity - left.severity || right.timestamp - left.timestamp);
  const visibleNotifications = attentionItems.filter(item => !clearedNotificationIds.includes(item.id));
  const unreadNotifications = visibleNotifications;
  const clearNotifications = () => setClearedNotificationIds(previous => [...new Set([...previous, ...visibleNotifications.map(item => item.id)])]);
  const openNotification = (item: typeof attentionItems[number]) => {
    if (!item.targetId) return;
    setNotificationsOpen(false);
    navigate(item.destination);
    window.setTimeout(() => {
      const target = document.getElementById(item.targetId);
      if (!target) return;
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.classList.add('notification-target-highlight');
      window.setTimeout(() => target.classList.remove('notification-target-highlight'), 2200);
    }, 80);
  };

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

  useEffect(() => {
    if (deviceNotificationPermission !== 'granted' || typeof Notification === 'undefined') return;
    for (const request of threadHelpRequests) {
      const notificationId = `thread-help-${request.id}`;
      if (nativeNotifiedIds.current.has(notificationId) || relativeTimeNow - request.createdAt > 60 * 60 * 1000) continue;
      nativeNotifiedIds.current.add(notificationId);
      try {
        const notification = new Notification('An agent needs your help', {
          body: `${request.title}: ${request.body.replace(/\s+/g, ' ').slice(0, 220)}`,
          tag: notificationId,
        });
        notification.onclick = () => {
          window.focus();
          setThreadToOpen(request.threadId);
          navigate('threads');
        };
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : 'An agent help notification could not be shown.');
      }
    }
    try {
      window.localStorage.setItem('symbiote-device-notified', JSON.stringify([...nativeNotifiedIds.current].slice(-200)));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Device notification state could not be saved.');
    }
  }, [deviceNotificationPermission, threadHelpRequests, relativeTimeNow]);

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
    return <MinimalMode theme={theme} agentName={config?.agentName || config?.name} agentEmoji={config?.agentEmoji} agentAvatarDataUrl={config?.agentAvatarDataUrl} onThemeChange={() => changeAppearance({ ...appearance, brightness: appearance.brightness >= 50 ? 0 : 100 })} />;
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
            return <>
              <span className="workspace-avatar"><AgentAvatar emoji={config?.agentEmoji} image={config?.agentAvatarDataUrl} size={16} /></span>
              <span className="workspace-copy"><strong>{config?.agentName || config?.name || 'Agent'}</strong></span>
              <Settings2 size={14} className="muted-icon" />
            </>;
          })()}
        </button>

        <nav className="sidebar-navigation" aria-label="Sections">
          {['Work', 'Tools', 'Runtime', 'Play'].map(group => (
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
                    {item.id === 'agents' && <span className="nav-count">{workspaceAgents.length + agents.length}</span>}
                    {item.id === 'projects' && <span className="nav-count">{projects.filter(project => !project.archivedAt).length}</span>}
                    {item.id === 'threads' && threadHelpRequests.length > 0 && <span className="nav-count">{threadHelpRequests.length}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="sidebar-session">
          <div className="sidebar-section-heading">
            <button className="sidebar-thread-toggle" type="button" onClick={() => setRecentThreadsOpen(open => !open)} aria-expanded={recentThreadsOpen} aria-controls="sidebar-thread-list">
              <span>RECENT THREADS</span><ChevronUp size={14} className={recentThreadsOpen ? 'thread-toggle-open' : ''} />
            </button>
            <button className="icon-button small" onClick={() => void createSession()} aria-label="Start a new conversation"><Plus size={15} /></button>
          </div>
          <div id="sidebar-thread-list" className="sidebar-thread-popover" data-open={recentThreadsOpen} role="region" aria-label="Previous conversations" aria-hidden={!recentThreadsOpen} inert={!recentThreadsOpen}>
            <div className="sidebar-thread-list">
              {sessions.map(session => (
                <button key={session.id} className={`recent-thread${activeSessionId === session.id && view === 'chat' ? ' recent-thread-active' : ''}`} onClick={() => { selectSession(session.id); navigate('chat'); setRecentThreadsOpen(false); }}>
                  <span className="thread-dot" />
                  <span className="recent-thread-copy"><strong>{session.label || 'Conversation'}</strong><small>{formatRelative(session.updatedAt)}</small></span>
                </button>
              ))}
              {sessions.length === 0 && <p className="sidebar-empty">Your conversations will appear here.</p>}
            </div>
          </div>
        </div>
          <div className="sidebar-footer">
            <a className="sidebar-footer-link" href="https://www.artifactvirtual.com" target="_blank" rel="noreferrer" aria-label="Open Artifact Virtual website">
              <img className="sidebar-footer-logo" src="/av-mark-white.png" alt="Artifact Virtual" />
            </a>
            <span className="version-label">{__SYMBIOTE_VERSION__}</span>
          </div>
      </aside>

      {mobileNavOpen && <button className="mobile-scrim" onClick={() => setMobileNavOpen(false)} aria-label="Close navigation overlay" />}

      <div className="main-column">
        <header className="topbar">
          <div className="topbar-left">
            <button className="icon-button mobile-menu" onClick={() => setMobileNavOpen(true)} aria-label="Open navigation"><Menu size={19} /></button>
            <div className="breadcrumb"><span className="breadcrumb-divider">/</span><strong>{view === 'chat' ? activeSession?.label || 'Conversation' : currentNavigation.label}</strong></div>
          </div>
          <div className="topbar-right">
            {isDesktopApp && <button className="icon-button utility-button" onClick={() => void window.symbioteDesktop?.openMini()} aria-label="Open floating mini chat" title="Open floating mini chat"><Minimize2 size={16} /></button>}
            <span className={`live-indicator${isOnline ? ' live-indicator-on' : ' live-indicator-retrying'}`}><span />{isOnline ? 'LIVE' : 'RETRYING'}</span>
            <button className="icon-button utility-button" onClick={() => { setCommandOpen(true); setCommandQuery(''); }} aria-label="Open command menu (Ctrl+K)" title="Command menu · Ctrl+K">
              <Command size={16} />
            </button>
            <AppearanceControl settings={appearance} onChange={changeAppearance} />
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
                    {visibleNotifications.length > 0 && <button className="text-button" onClick={clearNotifications}>Clear</button>}
                  </div>
                </header>
                {visibleNotifications.length ? <div className="notification-list">{visibleNotifications.map(item => <button key={item.id} className="notification-item" onClick={() => openNotification(item)}>
                  <span className={`notification-mark notification-severity-${item.severity}`} />
                  <span className="notification-copy"><strong>{item.title}</strong><small>{item.detail}</small><time>{notificationTimestamp(item.timestamp)}</time></span>
                </button>)}</div> : <p className="notification-empty">Nothing needs your attention.</p>}
                  <ResourceStatusStrip host={status?.metrics?.system?.host} />
                </section>}
            </div>
          </div>
        </header>

        <main id="main-content" className={`main-content${view === 'chat' ? ' main-content-chat' : ''}`}>
          <div className="floating-notices" aria-live="polite">
            {commandNotice && <div className="notice notice-info" role="status"><span>{commandNotice}</span><button className="icon-button small" onClick={() => setCommandNotice('')} aria-label="Dismiss status"><X size={14} /></button></div>}
            {error && <div className="notice notice-error" role="alert"><span>{error}</span><button className="icon-button small" onClick={() => void refreshAll(true)} aria-label="Retry"><RefreshCw size={14} /></button><button className="icon-button small" onClick={() => setError('')} aria-label="Dismiss error"><X size={14} /></button></div>}
            {status?.update?.state === 'available' && status.update.latestVersion !== dismissedUpdateVersion && (
              <div className="notice notice-update" role="status">
                <span>Symbiote {status.update.latestVersion} is available.</span>
                {isDesktopApp
                  ? <button className="button button-secondary" onClick={() => void installUpdate()} disabled={preparingUpdate || status.update.download?.state === 'downloading'}>
                      {preparingUpdate || status.update.download?.state === 'downloading' ? 'Preparing installer…' : 'Install update'}
                    </button>
                  : <a className="button button-secondary" href={status.update.releaseUrl} target="_blank" rel="noreferrer">View update</a>}
                <button className="icon-button small" onClick={() => setDismissedUpdateVersion(status.update?.latestVersion ?? null)} aria-label="Dismiss update notice"><X size={14} /></button>
              </div>
            )}
          </div>

          {loading && !status ? (
            <div className="loading-state"><ActivityOrb label="Connecting" loading /><span>Connecting to your local runtime…</span></div>
          ) : (
            <>
              {view === 'workspace' && (
                <OverviewView
                  status={status}
                  config={config}
                  sessions={sessions}
                  projects={projects}
                  profiles={workspaceAgents}
                  activeSessionId={activeSessionId}
                  agentActivity={heroActivity}
                  agents={agents}
                  channels={channelList}
                  memoryHistory={memoryHistory}
                  hostHistory={hostHistory}
                  refreshIntervalMs={refreshIntervalMs}
                  lastUpdated={lastUpdated}
                  onNavigate={navigate}
                  onStartRun={launchRun}
                  startingRun={startingRun}
                  onNewSession={() => void createSession()}
                  onOpenSession={openRunSession}
                  onOpenProject={openProjectDetails}
                  onOpenProfile={profile => void openProfileConversation(profile)}
                  lighting={lighting}
                  onResolveProject={resolveProject}
                  onSendAgentResponse={handleSendAgentResponse}
                  creatingSession={creatingSession}
                  cloudIntegrations={cloudIntegrations}
                />
              )}
              {view === 'ide' && (
                <Suspense fallback={<div className="loading-state"><ActivityOrb label="Loading the project IDE" loading /><span>Loading the project IDE…</span></div>}>
                  <ProjectIDE
                    projects={projects}
                    profiles={workspaceAgents}
                    onArchiveProject={archiveProject}
                    onRunTask={runProjectTask}
                    request={api}
                    dark={appearance.brightness < 50}
                  />
                </Suspense>
              )}
              {view === 'runs' && (
                <RunsView
                  runs={contextRuns}
                  agents={contextAgents}
                  onStop={stopRun}
                  onRestart={restartRun}
                  onGuide={guideRun}
                  onArchive={archiveRun}
                  onRestore={restoreRun}
                  onOpenSession={openRunSession}
                  request={api}
                />
              )}
              {view === 'agents' && (
                <AgentsView
                  agents={contextAgents}
                  profiles={workspaceAgents}
                  projects={projects}
                  onControl={controlAgent}
                  onOpenProfile={profile => void openProfileConversation(profile)}
                  onCreateAgent={createWorkspaceAgent}
                />
              )}
              {view === 'projects' && (
                <ProjectsView
                  projects={projects}
                  profiles={workspaceAgents}
                  agents={agents}
                  selectedProjectId={workspaceProjectId}
                  onSelectProject={id => { setWorkspaceProjectId(id); setWorkspaceAgentId(''); }}
                  onCreateProject={createProject}
                  onRestoreProject={restoreProject}
                  onArchiveProject={archiveProject}
                  onDeleteProject={permanentlyDeleteProject}
                  onProjectUpdated={updateProject}
                  request={api}
                  onOpenIDE={() => navigate('ide')}
                />
              )}
              {view === 'threads' && (
                <div className="page threads-page">
                  <PageHeading eyebrow="MULTI-AGENT COLLABORATION" title="Threads" detail="Coordinate work across agents, review help requests, and keep private project discussions in one place." />
                  <ThreadsPanel request={api} projects={projects} profiles={workspaceAgents} selectedProjectId={workspaceProjectId} requestedThreadId={threadToOpen} />
                </div>
              )}
              {view === 'chat' && (
                <ChatView
                  session={activeSession}
                  sessions={sessions}
                  messages={messages}
                  agentName={activeProfile?.name ?? config?.agentName ?? config?.name}
                  agentEmoji={activeProfile?.emoji ?? config?.agentEmoji}
                  agentAvatarDataUrl={activeProfile ? undefined : config?.agentAvatarDataUrl}
                  draft={sessionDraft}
                  sending={sending}
                  onDraft={value => setSessionDrafts(previous => ({ ...previous, [activeSessionId]: value }))}
                  onSubmit={sendMessage}
                  onStop={() => void interruptChat()}
                  onNewSession={() => void createSession()}
                  onSelectSession={selectSession}
                  onArchiveSession={archiveSession}
                  bottomRef={bottomRef}
                  creatingSession={creatingSession}
                />
              )}
              {view === 'browser' && <BrowserView />}
              {view === 'memory' && <Suspense fallback={<div className="loading-state"><ActivityOrb label="Loading the memory map" loading /><span>Loading memory map…</span></div>}><MemoryMap request={api} onSendNode={sendMemoryNode} /></Suspense>}
              {view === 'integrations' && <Suspense fallback={<div className="loading-state"><ActivityOrb label="Loading integrations" loading /><span>Loading integrations…</span></div>}><IntegrationsView grant={googleWorkspaceGrant} onGrantChange={setGoogleWorkspaceGrant} request={api} cloudStatus={cloudProviderStatus} onCloudStatusChange={(provider, configured) => setCloudProviderStatus(previous => ({ ...previous, [provider]: configured }))} /></Suspense>}
              {view === 'operations' && (
                <OperationsView
                  status={status}
                  connected={gatewayConnected}
                  channels={channelList}
                  logLines={logLines}
                  query={logQuery}
                  onQuery={setLogQuery}
                  searchRef={logSearchRef}
                  lastUpdated={lastUpdated}
                  refreshIntervalMs={refreshIntervalMs}
                  onRefresh={() => void refreshAll(true)}
                  onRestartChannel={restartChannel}
                  onClearIncidents={clearHealthIncidents}
                />
              )}
              {view === 'tools' && (
                <ToolsView tools={filteredTools} total={tools.length} query={toolQuery} onQuery={setToolQuery} />
              )}
              {view === 'settings' && <SettingsView config={config} status={status} refreshIntervalMs={refreshIntervalMs} onRefreshIntervalChange={setRefreshIntervalMs} />}
              {view === 'games' && <Suspense fallback={<div className="loading-state"><ActivityOrb label="Loading games" loading /><span>Loading games…</span></div>}><GamesView request={api} /></Suspense>}
            </>
          )}
        </main>
      </div>
      <div hidden aria-hidden="true">
        <WorkspaceDrawer
          openRequest={0}
          projectOpenRequest={0}
          projectToOpen=""
          openThreadRequest={0}
          threadToOpen=""
          onOpenIDE={() => navigate('ide')}
          onOpenTasks={() => navigate('runs')}
          projects={projects}
          profiles={workspaceAgents}
          subagents={agents}
          selectedProjectId={workspaceProjectId}
          selectedAgentId={workspaceAgentId}
          onSelectProject={id => { setWorkspaceProjectId(id); setWorkspaceAgentId(''); setActiveSessionId(''); }}
          onSelectAgent={id => setWorkspaceAgentId(id)}
          onCreateProject={createProject}
          onRestoreProject={restoreProject}
          onArchiveProject={archiveProject}
          onDeleteProject={permanentlyDeleteProject}
          onProjectUpdated={updateProject}
          onCreateAgent={createWorkspaceAgent}
          onOpenProfile={profile => void openProfileConversation(profile)}
          onOpenSubagent={openSubagentConversation}
          onArchiveSubagent={id => void archiveSession(id)}
          unreadThreadCount={threadHelpRequests.length}
          onFailure={failure => setError(failure instanceof Error ? failure.message : 'Workspace change failed.')}
          request={api}
        />
      </div>
      {notificationsOpen && <button className="notification-dismiss" aria-label="Close notifications" onClick={() => setNotificationsOpen(false)} />}
      {identityOpen && config && <AgentSettingsDialog config={config} onSave={updateIdentity} onClose={() => setIdentityOpen(false)} />}
      {commandOpen && <CommandPalette
        query={commandQuery}
        onQuery={setCommandQuery}
        onClose={() => setCommandOpen(false)}
        onNavigate={destination => { setCommandOpen(false); navigate(destination); }}
        onNewSession={() => { setCommandOpen(false); void createSession(); }}
        onRestartGateway={() => { setCommandOpen(false); void restartGateway(); }}
        onChangeProviderModel={() => { setCommandOpen(false); setCommandAction('provider-model'); }}
        onCloneRepository={() => { setCommandOpen(false); setCommandAction('clone-repository'); }}
        onReboot={() => { setCommandOpen(false); void rebootComputer(); }}
        isDesktopApp={isDesktopApp && window.symbioteDesktop?.supportsReboot === true}
      />}
      {commandAction && <CommandActionDialog action={commandAction} config={config} onClose={() => setCommandAction(null)} onSubmit={runCommandAction} />}
    </div>
  );
}

function AgentSettingsDialog({ config, onSave, onClose }: {
  config: GatewayConfig;
  onSave: (identity: { name: string; emoji: string; soulContent: string; agentsContent: string; instructions: string; avatarDataUrl: string | null }) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(config.agentName || config.name || '');
  const [emoji, setEmoji] = useState(config.agentEmoji || 'bot');
  const [soulContent, setSoulContent] = useState(config.soulContent || '');
  const [agentsContent, setAgentsContent] = useState(config.agentsContent || '');
  const [instructions, setInstructions] = useState(config.agentInstructions || '');
  const [avatarDataUrl, setAvatarDataUrl] = useState<string | null>(config.agentAvatarDataUrl ?? null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const AgentIcon = AgentGlyph;
  const loadAvatar = (file?: File) => {
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setError('Choose a PNG, JPEG, or WebP image.');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setError('Agent avatar images must be 2 MiB or smaller.');
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setError('The selected image could not be read.');
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        setError('The selected image could not be read as a supported image.');
        return;
      }
      setAvatarDataUrl(reader.result);
      setError('');
    };
    reader.readAsDataURL(file);
  };
  return (
    <div className="identity-backdrop" onMouseDown={onClose}>
      <section className="identity-dialog" role="dialog" aria-modal="true" aria-labelledby="identity-title" onMouseDown={event => event.stopPropagation()}>
        <header className="identity-dialog-header">
          <span className="identity-dialog-icon">{avatarDataUrl ? <img src={avatarDataUrl} alt="" /> : <AgentIcon size={20} />}</span>
          <div><div className="eyebrow">AGENT PROFILE</div><h2 id="identity-title">Identity & behavior</h2></div>
          <button className="icon-button small" type="button" onClick={onClose} aria-label="Close agent settings"><X size={16} /></button>
        </header>
        <form onSubmit={async event => {
          event.preventDefault();
          setSaving(true);
          setError('');
          try {
            await onSave({ name: name.trim(), emoji, soulContent, agentsContent, instructions, avatarDataUrl });
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
          <fieldset className="identity-field identity-avatar-field">
            <legend>Agent avatar</legend>
            <div className="identity-avatar-selector">
              <label className="identity-avatar-upload">
                <input className="identity-avatar-file-input" type="file" accept="image/png,image/jpeg,image/webp" onChange={event => loadAvatar(event.currentTarget.files?.[0])} />
                <span className="identity-avatar-preview">{avatarDataUrl ? <img src={avatarDataUrl} alt="" /> : <Upload size={16} />}</span>
                <span>Upload image</span>
              </label>
              <span className="identity-avatar-or">or</span>
              <AgentIconPicker id="identity-agent-icon" value={emoji} onChange={value => { setEmoji(value); setAvatarDataUrl(null); }} />
            </div>
            <small>Used throughout the workspace and chat. Subagents keep their bot icon. PNG, JPEG, or WebP up to 2 MiB.</small>
            {avatarDataUrl && <button className="button button-secondary identity-avatar-remove" type="button" onClick={() => setAvatarDataUrl(null)}>Remove custom avatar</button>}
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
            <button className="button button-primary" type="submit" disabled={saving || !name.trim()}>{saving ? <ActivityOrb label="Saving identity" compact loading /> : <Check size={14} />}{saving ? 'Saving' : 'Save identity'}</button>
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
  projects: WorkspaceProject[];
  profiles: AgentProfile[];
  activeSessionId: string;
  agentActivity: AgentActivity;
  agents: WorkspaceAgent[];
  channels: GatewayStatus['channels'];
  memoryHistory: number[];
  hostHistory: HostResourceSnapshot[];
  refreshIntervalMs: number;
  lastUpdated: number | null;
  onNavigate: (view: ViewId) => void;
  onStartRun: (prompt: string, sessionId: string) => Promise<boolean>;
  startingRun: boolean;
  onNewSession: () => void;
  onOpenSession: (id: string) => void;
  onOpenProject: (id: string) => void;
  onOpenProfile: (profile: AgentProfile) => void;
  lighting: AgentLightingState;
  onResolveProject: (completionKey: string) => void;
  onSendAgentResponse: (agentId: string, response: string) => Promise<void>;
  creatingSession: boolean;
  cloudIntegrations: Array<{ id: string; label: string; online: boolean; view: ViewId; icon: ReactNode }>;
}) {
  const { status, config, sessions, projects, profiles, activeSessionId, agentActivity, agents, channels, memoryHistory, hostHistory, refreshIntervalMs, lastUpdated, onNavigate, onStartRun, startingRun, onNewSession, onOpenSession, onOpenProject, onOpenProfile, lighting, onResolveProject, onSendAgentResponse, creatingSession, cloudIntegrations } = props;
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
  return (
    <div className="page page-overview">
      <PageHeading
        title={(config?.agentName || config?.name || 'Agent').toLowerCase()}
        detail={<WorkspaceClock />}
        action={
          <div className="overview-primary-actions">
            <button className="button button-primary" onClick={onNewSession} disabled={creatingSession}><Plus size={16} />New conversation</button>
            <div className="workspace-integration-links" aria-label="Cloud integrations">
              {cloudIntegrations.map(integration => (
                <button
                  key={integration.id}
                  type="button"
                  className={`workspace-integration-icon${integration.online ? ' workspace-integration-online' : ''}`}
                  onClick={() => onNavigate(integration.view)}
                  title={`${integration.label} ${integration.online ? 'online' : 'offline'}`}
                  aria-label={`Open Integrations. ${integration.label} ${integration.online ? 'online' : 'offline'}`}
                >
                  {integration.icon}
                  <span className="workspace-integration-light" aria-hidden="true" />
                </button>
              ))}
            </div>
          </div>
        }
      />

      <section className="overview-banner">
        <div className="banner-orbit orbit-one" /><div className="banner-orbit orbit-two" />
        <div className="banner-copy">
          {!status && <p>Start the Symbiote gateway to bring your control room online.</p>}
          {status && <HeroTaskForm sessionId={activeSessionId} onStart={onStartRun} starting={startingRun} onNavigate={onNavigate} />}
        </div>
        <WorkspaceGraph
          sessions={sessions}
          projects={projects}
          profiles={profiles}
          agents={agents}
          activity={agentActivity}
          onOpenSession={onOpenSession}
          onOpenProject={onOpenProject}
          onOpenProfile={onOpenProfile}
          lighting={lighting}
          onResolveProject={onResolveProject}
          onSendAgentResponse={onSendAgentResponse}
        />
      </section>

      <section className="metric-grid" aria-label="Runtime summary">
        <MetricCard icon={Activity} label="Active turns" tone="orange">
          <strong className="metric-value">{status?.activeTurns ?? '—'}</strong>
          <span className="metric-detail">Running</span>
        </MetricCard>
        <MetricCard icon={MessageSquare} label="Conversations" tone="green">
          <strong className="metric-value">{status?.sessions ?? sessions.length}</strong>
          <span className="metric-detail">Saved</span>
        </MetricCard>
        <MetricCard icon={Server} label="Uptime" tone="neutral">
          <div className="uptime-card-main"><strong className="metric-value">{status?.uptimeHuman || '—'}</strong><StopwatchDial seconds={(status?.uptime ?? 0) / 1000} /></div>
        </MetricCard>
        <MemoryInUseCard host={host} processRssMb={memory?.rss} />
      </section>
      <section className="metric-grid system-metric-grid" aria-label="Computer resource usage">
        <MetricCard icon={Cpu} label="CPU" tone="orange">
          <div className="metric-reading"><strong className="metric-value">{host?.cpuPercent === null || host?.cpuPercent === undefined ? '—' : `${host.cpuPercent.toFixed(1)}%`}</strong><span>{host ? `${host.cpuLogicalCores} cores` : 'Waiting for sample'}</span></div>
          <MetricPlot
            label={`Host CPU utilization over time across ${host?.cpuLogicalCores ?? 0} logical cores`}
            series={Array.from({ length: host?.cpuLogicalCores ?? 0 }, (_, index) => ({
              name: `Core ${index + 1}`,
              color: '',
              values: hostHistory.map(sample => sample.cpuCorePercents?.[index] ?? (index === 0 ? sample.cpuPercent ?? 0 : 0)),
            }))}
            maxValue={100}
          />
        </MetricCard>
        <GpuUsageCard host={host} hostHistory={hostHistory} />
        <MetricCard icon={Network} label="Network I/O" tone="green">
          <div className="metric-dual-reading"><span><b>↓</b> {formatRate(host?.network.receiveBytesPerSecond)}</span><span><b>↑</b> {formatRate(host?.network.transmitBytesPerSecond)}</span></div>
          <MetricPlot label="Network receive and transmit rates" series={[
            { name: 'Down', color: 'var(--appearance-icon)', values: hostHistory.map(sample => sample.network.receiveBytesPerSecond ?? 0) },
            { name: 'Up', color: 'color-mix(in srgb, var(--appearance-icon) 48%, var(--ink))', values: hostHistory.map(sample => sample.network.transmitBytesPerSecond ?? 0) },
          ]} />
        </MetricCard>
        <MetricCard icon={HardDrive} label="Disk I/O" tone="neutral">
          <div className="metric-dual-reading"><span>Read {formatRate(host?.disk.readBytesPerSecond)}</span><span>Write {formatRate(host?.disk.writeBytesPerSecond)}</span></div>
          <MetricPlot label="Disk read and write rates" series={[
            { name: 'Read', color: 'var(--appearance-icon)', values: hostHistory.map(sample => sample.disk.readBytesPerSecond ?? 0) },
            { name: 'Write', color: 'color-mix(in srgb, var(--appearance-icon) 48%, var(--ink))', values: hostHistory.map(sample => sample.disk.writeBytesPerSecond ?? 0) },
          ]} />
        </MetricCard>
      </section>

      <div className="overview-columns">
        <section className="surface-card runtime-card">
          <div className="section-heading">
            <div><div className="eyebrow">UNDER THE HOOD</div><h2>Runtime pulse</h2></div>
            <span className="subtle-label">{lastUpdated ? `UPDATED ${new Date(lastUpdated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'WAITING'}</span>
          </div>
          <div className="runtime-stat">
            <div className="runtime-stat-heading"><span>Process memory</span><strong>{formatBytes(memory?.rss)}</strong></div>
            <Sparkline values={memoryHistory} />
            <div className="runtime-footnote"><span>Resident set size</span><span>Live · {refreshIntervalMs} ms refresh</span></div>
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

        <section className="surface-card work-card">
          <div className="section-heading">
            <div><div className="eyebrow">RECENT</div><h2>Conversations</h2></div>
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
            <EmptyState icon={MessageSquare} title="No conversations yet" detail="Start a conversation with the agent." action={<button className="button button-secondary" onClick={onNewSession}><Plus size={15} />Start a conversation</button>} />
          )}
        </section>
      </div>

      <section className="surface-card channel-card">
        <div className="section-heading">
          <div><div className="eyebrow">CONNECTED SURFACES</div><h2>Channels</h2></div>
          <button className="text-button" onClick={() => onNavigate('operations')}>Health <ArrowUpRight size={14} /></button>
        </div>
        {channels.length ? (
          <div className="channel-grid">
            {channels.map(channel => <ChannelTile key={channel.id} channel={channel} qr={status?.whatsappQr} />)}
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
  'What do you need done?',
  'What would you like me to get done?',
  'What task can I take care of?',
  'What would you like me to handle?',
  'What needs doing?',
  'What should I get started on?',
  'What would you like me to work on?',
  'What can I help you accomplish?',
  'What are we getting done today?',
  'What would you like to make happen?',
  'What should I take off your hands?',
  'What can I take care of for you?',
  'What do you want to tackle?',
  'What would you like us to finish?',
  'What needs your attention right now?',
  'What would you like me to sort out?',
  'What should I help you complete?',
  'What are you looking to get done?',
  'What do you need help with today?',
  'What would you like me to take on?',
  'What is the job you need done?',
  'What should we work through?',
  'What do you want me to take care of?',
  'What would make your day easier?',
  'What can I help move forward?',
  'What needs to happen next?',
  'What should I focus on for you?',
  'What would you like me to sort?',
  'What do you need help finishing?',
  'What would you like to get off your list?',
  'What should I help make progress on?',
  'What can I do for you?',
  'What would you like me to complete?',
  'What needs to be taken care of?',
  'What should I help you get across the line?',
  'What can I help you get done?',
  'What would you like me to make progress on?',
  'What are we trying to accomplish?',
  'What task should I pick up?',
  'What do you want handled?',
  'What should I help you get sorted?',
  'What would you like to have finished?',
  'What can I help you wrap up?',
  'What do you want me to work through?',
  'What needs to be done first?',
  'What would you like me to take forward?',
  'What should I get moving for you?',
  'What do you need taken care of?',
  'What would you like done next?',
  'What can I get done on your behalf?',
];

const TASK_HELP = 'Launch an agent run in this project. The agent can delegate independent work to subagents.';

function HeroTaskForm({ sessionId, onStart, starting, onNavigate }: {
  sessionId: string;
  onStart: (prompt: string, sessionId: string) => Promise<boolean>;
  starting: boolean;
  onNavigate: (view: ViewId) => void;
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
            onNavigate('runs');
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
          {starting ? <ActivityOrb label="Starting task" compact loading /> : <ArrowRight size={15} />}
        </button>
      </div>
    </form>
  );
}

interface GraphNode {
  id: string;
  label: string;
  kind: 'main' | 'conversation' | 'project' | 'profile' | 'agent';
  parentId?: string;
  sessionId?: string;
  projectId?: string;
  agentId?: string;
  status?: WorkspaceAgent['status'];
  // Lighting state
  agentActive?: boolean;  // Node is actively making calls
  projectPending?: boolean;  // Project has agents awaiting user response
  projectResolveId?: string;  // ID to resolve on click
  agentResponseRequired?: boolean;  // Agent needs user response to proceed
}

interface GraphPoint { x: number; y: number; }

function WorkspaceGraph({ sessions, projects, profiles, agents, activity, onOpenSession, onOpenProject, onOpenProfile, lighting, onResolveProject, onSendAgentResponse }: {
  sessions: SessionSummary[];
  projects: WorkspaceProject[];
  profiles: AgentProfile[];
  agents: WorkspaceAgent[];
  activity: AgentActivity;
  onOpenSession: (id: string) => void;
  onOpenProject: (id: string) => void;
  onOpenProfile: (profile: AgentProfile) => void;
  lighting?: {
    agentActiveNodes: Set<string>;
    projectPendingNodes: Map<string, string>;
    agentResponseNodes: Map<string, string>;
  };
  onResolveProject?: (projectId: string) => void;
  onSendAgentResponse: (agentId: string, response: string) => Promise<void>;
}) {
  const [sendInputValue, setSendInputValue] = useState('');
  const [sendingAgentResponse, setSendingAgentResponse] = useState(false);
  const [agentResponseError, setAgentResponseError] = useState('');
  const nodes = useMemo<GraphNode[]>(() => {
    const conversations = sessions
      .filter(session => session.sessionKind === 'conversation' || (session.id.startsWith('web-') && !session.id.startsWith('web-run-')))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, 24);
    const conversationIds = new Set(conversations.map(session => session.id));
    const sessionById = new Map(sessions.map(session => [session.id, session]));
    const activeAgents = agents.slice().sort((left, right) => right.startedAt - left.startedAt).slice(0, 16);
    const agentNodeIds = new Set(activeAgents.map(agent => agent.sessionId));
    const profileNodeIds = new Set(profiles.map(profile => profile.id));
    const projectIds = new Set(projects.map(project => project.id));
    const graphNodes: GraphNode[] = [
      { id: 'main', label: 'Main agent', kind: 'main' },
      ...projects.map(project => ({
        id: `project:${project.id}`,
        label: project.name,
        kind: 'project' as const,
        parentId: 'main',
        projectId: project.id,
      })),
      ...profiles.map(profile => ({
        id: `profile:${profile.id}`,
        label: profile.name,
        kind: 'profile' as const,
        parentId: projectIds.has(profile.projectId) ? `project:${profile.projectId}` : 'main',
        projectId: profile.projectId,
        agentId: profile.id,
      })),
      ...conversations.map(session => ({
        id: session.id,
        sessionId: session.id,
        label: session.label || 'Conversation',
        kind: 'conversation' as const,
        parentId: session.agentId && profileNodeIds.has(session.agentId)
          ? `profile:${session.agentId}`
          : session.projectId && projects.some(project => project.id === session.projectId)
            ? `project:${session.projectId}`
            : 'main',
      })),
      ...activeAgents.map(agent => {
        const parentSession = agent.parentSessionId ? sessionById.get(agent.parentSessionId) : undefined;
        const parentAgent = agent.parentSessionId && agentNodeIds.has(agent.parentSessionId);
        const parentProfileId = parentSession?.agentId ?? agent.agentId;
        const parentId = parentAgent
          ? agent.parentSessionId
          : parentProfileId && profileNodeIds.has(parentProfileId)
            ? `profile:${parentProfileId}`
            : agent.parentSessionId && conversationIds.has(agent.parentSessionId)
              ? agent.parentSessionId
              : agent.projectId && projects.some(project => project.id === agent.projectId)
                ? `project:${agent.projectId}`
                : 'main';
        return {
        id: agent.sessionId,
        sessionId: agent.sessionId,
        label: agent.task,
        kind: 'agent' as const,
        parentId,
        projectId: agent.projectId,
        agentId: agent.agentId,
        status: agent.status,
        };
      }),
    ];
    const graphNodesById = new Map(graphNodes.map(node => [node.id, node]));
    for (const node of graphNodes) {
      let ancestorId = node.parentId;
      const ancestors = new Set([node.id]);
      let hasMissingAncestor = false;
      while (ancestorId && ancestorId !== 'main') {
        if (ancestors.has(ancestorId)) {
          hasMissingAncestor = true;
          break;
        }
        ancestors.add(ancestorId);
        const ancestor = graphNodesById.get(ancestorId);
        if (!ancestor) {
          hasMissingAncestor = true;
          break;
        }
        ancestorId = ancestor.parentId;
      }
      if (hasMissingAncestor) node.parentId = 'main';
    }
    return graphNodes;
  }, [sessions, projects, profiles, agents]);
  const points = useMemo(() => {
    const center = { x: 280, y: 220 };
    const positions: Record<string, GraphPoint> = { main: center };
    const angles = new Map<string, number>();
    const depths = new Map<string, number>([['main', 0]]);
    const baseRadii = new Map<string, number>();
    const byId = new Map(nodes.map(node => [node.id, node]));
    const children = new Map<string, GraphNode[]>();
    for (const node of nodes) {
      if (!node.parentId) continue;
      const siblings = children.get(node.parentId) ?? [];
      siblings.push(node);
      children.set(node.parentId, siblings);
    }
    const rootConversations = children.get('main')?.filter(node => node.kind === 'conversation') ?? [];
    const rootProjects = children.get('main')?.filter(node => node.kind === 'project') ?? [];
    const place = (node: GraphNode, seen = new Set<string>()): GraphPoint => {
      const existing = positions[node.id];
      if (existing) return existing;
      if (seen.has(node.id)) return positions.main;
      const nextSeen = new Set(seen).add(node.id);
      const parent = node.parentId && byId.get(node.parentId);
      const siblings = children.get(node.parentId ?? '') ?? [];
      const siblingIndex = siblings.findIndex(item => item.id === node.id);
      let point: GraphPoint;
      if (node.parentId === 'main' && node.kind === 'conversation') {
        const index = rootConversations.findIndex(item => item.id === node.id);
        const angle = -Math.PI / 2 + index / Math.max(1, rootConversations.length) * Math.PI * 2;
        const radius = rootConversations.length === 1 ? 66 : 72;
        angles.set(node.id, angle);
        depths.set(node.id, 1);
        baseRadii.set(node.id, radius);
        point = { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius };
      } else if (node.parentId === 'main' && node.kind === 'project') {
        const index = rootProjects.findIndex(item => item.id === node.id);
        const angle = -Math.PI / 2 + index / Math.max(1, rootProjects.length) * Math.PI * 2;
        angles.set(node.id, angle);
        depths.set(node.id, 1);
        baseRadii.set(node.id, 112);
        point = { x: center.x + Math.cos(angle) * 112, y: center.y + Math.sin(angle) * 112 };
      } else if (!parent) {
        point = center;
      } else {
        place(parent, nextSeen);
        const parentAngle = angles.get(parent.id) ?? -Math.PI / 2;
        const rootRadius = baseRadii.get(parent.id) ?? baseRadii.get(parent.parentId ?? '') ?? 90;
        const parentDepth = depths.get(parent.id) ?? 1;
        const depth = parentDepth + 1;
        const angleSpread = Math.min(1.25, Math.max(0.24, siblings.length * 0.17));
        const siblingOffset = siblings.length <= 1 ? 0 : (siblingIndex / (siblings.length - 1) - 0.5) * angleSpread;
        const angle = parentAngle + 0.12 + siblingOffset;
        const radius = Math.min(190, rootRadius + (depth - 1) * 32);
        angles.set(node.id, angle);
        depths.set(node.id, depth);
        baseRadii.set(node.id, rootRadius);
        point = {
          x: center.x + Math.cos(angle) * radius,
          y: center.y + Math.sin(angle) * radius,
        };
      }
      positions[node.id] = point;
      return point;
    };
    for (const node of nodes) place(node);
    return positions;
  }, [nodes]);

  return (
  <div className="hero-map-wrapper">
    <div className="hero-map-controls">
      {lighting && Array.from(lighting.projectPendingNodes.keys()).length > 0 && (
        <button
          type="button"
          className="hero-map-resolve-button"
          onClick={() => {
            const completionKey = lighting.projectPendingNodes.values().next().value;
            if (completionKey) onResolveProject?.(completionKey);
          }}
          aria-label="Resolve project notification"
          title="Clear project notification"
        >
          Resolve
        </button>
      )}
    </div>
    <svg className="banner-illustration workspace-graph" viewBox="0 0 560 440" role="group" aria-label="Circular workspace graph. Conversations orbit the main agent, with projects, agents, and subagents expanding outward.">
      <defs>
        <radialGradient id="agent-glow"><stop stopColor="var(--appearance-icon)" stopOpacity=".3" /><stop offset="1" stopColor="var(--appearance-icon)" stopOpacity="0" /></radialGradient>
        <radialGradient id="agent-surface" cx="32%" cy="25%" r="78%">
          <stop stopColor="var(--appearance-highlight)" />
          <stop offset=".48" stopColor="var(--appearance-primary)" />
          <stop offset="1" stopColor="color-mix(in srgb, var(--appearance-primary) 42%, var(--ink))" />
        </radialGradient>
      </defs>
      {nodes.filter(node => node.parentId).map(node => {
        const child = points[node.id];
        const parent = node.parentId === 'main' ? { x: 280, y: 220 } : points[node.parentId!];
        if (!child || !parent) return null;
        const dx = child.x - parent.x;
        const dy = child.y - parent.y;
        const distance = Math.max(1, Math.hypot(dx, dy));
        const bend = Math.min(9, distance * 0.08);
        const controlX = (parent.x + child.x) / 2 - dy / distance * bend;
        const controlY = (parent.y + child.y) / 2 + dx / distance * bend;
        const edgePath = `M ${parent.x} ${parent.y} Q ${controlX} ${controlY} ${child.x} ${child.y}`;
        return <path
          key={`link-${node.id}`}
          className={`graph-link graph-link-${node.kind}${node.parentId === 'main' ? ' graph-link-root' : ''}${node.status === 'running' ? ' graph-link-active' : ''}`}
          d={edgePath}
        />;})}
      {nodes.map(node => {
        const point = node.kind === 'main' ? { x: 280, y: 220 } : points[node.id];
        if (!point) return null;
        if (node.kind === 'main') return (
          <HeroAgentOrb key={node.id} x={point.x} y={point.y} activity={activity} />
        );
        const description = node.kind === 'conversation' ? 'Open conversation'
          : node.kind === 'project' ? 'Open project details'
            : node.kind === 'profile' ? 'Open agent conversation'
              : 'Open subagent conversation';
        const activate = () => {
          if (node.kind === 'conversation' || node.kind === 'agent') onOpenSession(node.sessionId!);
          else if (node.kind === 'project') onOpenProject(node.projectId!);
          else if (node.kind === 'profile') {
            const profile = profiles.find(item => item.id === node.agentId);
            if (profile) onOpenProfile(profile);
          }
        };
        const isAgentActive = lighting?.agentActiveNodes.has(node.id) ?? false;
        const isProjectPending = lighting?.projectPendingNodes.has(node.id) ?? false;
        const isAgentResponseRequired = lighting?.agentResponseNodes.has(node.id) ?? false;
        const isLit = isAgentActive || isProjectPending || isAgentResponseRequired;
        return (
          <g
            key={node.id}
            className={`graph-node graph-node-${node.kind}${node.status === 'running' ? ' graph-node-active' : ''}${isLit ? ' graph-node-lit' : ''}${isAgentActive ? ' graph-node-agent-active' : ''}${isProjectPending ? ' graph-node-project-pending' : ''}${isAgentResponseRequired ? ' graph-node-agent-response' : ''}`}
            role="button"
            tabIndex={0}
            aria-label={`${description}: ${node.label}${isLit ? ' (lit)' : ''}`}
            onClick={activate}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                activate();
              }
            }}
          >
            <title>{node.label}{isLit ? ' — lit' : ''}</title>
            {node.kind === 'project'
              ? <rect x={point.x - 6} y={point.y - 6} width="12" height="12" rx="2" />
              : node.kind === 'conversation'
                ? <rect x={point.x - 4} y={point.y - 5} width="8" height="10" rx="1.5" />
                : <circle cx={point.x} cy={point.y} r={node.kind === 'profile' ? 5 : 4} />}
          </g>
        );})}
    </svg>

<div className="hero-map-send-field">
      {lighting && Array.from(lighting.agentResponseNodes.keys()).length > 0 && (
        <form className="hero-map-send-container" onSubmit={async event => {
          event.preventDefault();
          const agentId = lighting.agentResponseNodes.keys().next().value;
          if (!agentId || !sendInputValue.trim() || sendingAgentResponse) return;
          setSendingAgentResponse(true);
          setAgentResponseError('');
          try {
            await onSendAgentResponse(agentId, sendInputValue.trim());
            setSendInputValue('');
          } catch (error) {
            setAgentResponseError(error instanceof Error ? error.message : 'Could not send guidance to the agent.');
          } finally {
            setSendingAgentResponse(false);
          }
        }}>
          <input
            type="text"
            className="hero-map-send-input"
            placeholder="Send guidance to agent..."
            aria-label="Send guidance to agent"
            value={sendInputValue}
            onChange={event => setSendInputValue(event.target.value)}
            disabled={sendingAgentResponse}
          />
          <button
            type="submit"
            className="hero-map-send-button"
            aria-label="Send guidance"
            title="Send guidance"
            disabled={sendingAgentResponse || !sendInputValue.trim()}
          >
            {sendingAgentResponse ? <ActivityOrb label="Sending guidance" compact loading /> : <Send size={15} />}
          </button>
          {agentResponseError && <span className="hero-map-send-error" role="alert">{agentResponseError}</span>}
        </form>
      )}
    </div>
  </div>
)
}

function RunStatus({ status }: { status: WorkspaceRun['status'] }) {
  const Icon = status === 'running' ? Clock3 : status === 'completed' ? CircleCheck : CircleAlert;
  return <span className={`run-status run-status-${status}`}><Icon size={13} />{status}</span>;
}

function RunsView({ runs, agents, onStop, onRestart, onGuide, onArchive, onRestore, onOpenSession, request }: {
  runs: WorkspaceRun[];
  agents: WorkspaceAgent[];
  onStop: (id: string) => void;
  onRestart: (id: string) => void;
  onGuide: (id: string, message: string) => Promise<void>;
  onArchive: (id: string) => void;
  onRestore: (id: string) => void;
  onOpenSession: (sessionId: string) => void;
  request: typeof api;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const archivedRuns = runs.filter(run => run.archivedAt);
  const activeRuns = runs.filter(run => !run.archivedAt && run.status === 'running').length;
  const completedRuns = runs.filter(run => !run.archivedAt && run.status === 'completed').length;
  const attentionRuns = runs.filter(run => !run.archivedAt && (run.status === 'failed' || run.status === 'cancelled')).length;
  const visibleRunCount = runs.filter(run => !run.archivedAt).length;
  const lanes: Array<{ key: string; title: string; description: string; items: WorkspaceRun[] }> = [
    { key: 'active', title: 'In progress', description: 'Live activity from the main agent and its subagents', items: runs.filter(run => !run.archivedAt && run.status === 'running') },
    { key: 'done', title: 'Completed', description: 'Finished task runs', items: runs.filter(run => !run.archivedAt && run.status === 'completed') },
    { key: 'attention', title: 'Needs attention', description: 'Stopped or failed runs', items: runs.filter(run => !run.archivedAt && (run.status === 'failed' || run.status === 'cancelled')) },
  ];
  return (
    <div className="page management-page task-page">
      <PageHeading
        eyebrow="TASK CONTROL ROOM"
        title="Tasks"
        detail="One control surface for live agent runs, scheduled automation, completion reviews, and recoverable history."
        action={<button type="button" className="button button-secondary" onClick={() => setShowArchived(current => !current)} aria-expanded={showArchived}><Archive size={14} />{showArchived ? 'Hide archived' : `Archived${archivedRuns.length ? ` · ${archivedRuns.length}` : ''}`}</button>}
      />
      <section className="management-stats task-stats" aria-label="Task run telemetry">
        <ManagementStat icon={Activity} label="Active runs" value={activeRuns} detail="Live agent work" tone={activeRuns ? 'green' : 'neutral'} />
        <ManagementStat icon={CircleCheck} label="Completed" value={completedRuns} detail="Ready for review" />
        <ManagementStat icon={CircleAlert} label="Needs attention" value={attentionRuns} detail="Failed or cancelled" tone={attentionRuns ? 'orange' : 'neutral'} />
        <ManagementStat icon={Workflow} label="Visible runs" value={visibleRunCount} detail={`${archivedRuns.length} archived`} />
      </section>
      <section className="management-section task-runs-section" aria-labelledby="task-runs-title">
        <header className="management-section-heading"><div><span className="eyebrow">RUN MANAGEMENT</span><h2 id="task-runs-title">Agent runs</h2><p>Track progress, inspect delegation, guide active work, and reopen run sessions.</p></div><span className="management-section-count">{visibleRunCount}</span></header>
        <div className="task-board" aria-label="Agentic task board">
          {lanes.map(lane => (
            <section className={`task-lane task-lane-${lane.key}`} key={lane.key} aria-label={`${lane.title} tasks`}>
              <header className="task-lane-heading">
                <div><h2>{lane.title}</h2><p>{lane.description}</p></div>
                <span>{lane.items.length}</span>
              </header>
              {lane.items.length ? lane.items.map(run => {
                const runAgents = agents.filter(agent => agent.parentSessionId === run.sessionId);
                return <TaskCard key={run.id} run={run} runAgents={runAgents} onStop={onStop} onRestart={onRestart} onGuide={onGuide} onArchive={onArchive} onOpenSession={onOpenSession} />;
              }) : <div className="task-lane-empty">No tasks here</div>}
            </section>
          ))}
        </div>
      </section>
      <section className="management-section task-automation-section" aria-labelledby="task-automation-title">
        <header className="management-section-heading"><div><span className="eyebrow">SCHEDULED AUTONOMY</span><h2 id="task-automation-title">Automation &amp; schedules</h2><p>Manage recurring and one-time agent work, review run alerts, and set the default scheduled-run instructions.</p></div></header>
        <div className="task-automation-card"><CronPanel request={request} /></div>
      </section>
      {showArchived && <section className="task-lane task-lane-archived" aria-label="Archived task runs">
        <header className="management-section-heading"><div><span className="eyebrow">RETAINED RUN HISTORY</span><h2>Archived runs</h2><p>Hidden from the active board; restore any run when needed.</p></div><span className="management-section-count">{archivedRuns.length}</span></header>
        {archivedRuns.length ? archivedRuns.map(run => <TaskCard key={run.id} run={run} runAgents={agents.filter(agent => agent.parentSessionId === run.sessionId)} onStop={onStop} onRestart={onRestart} onGuide={onGuide} onRestore={onRestore} onOpenSession={onOpenSession} />) : <div className="task-lane-empty">No archived runs</div>}
      </section>}
    </div>
  );
}

function TaskCard({ run, runAgents, onStop, onRestart, onGuide, onArchive, onRestore, onOpenSession }: {
  run: WorkspaceRun;
  runAgents: WorkspaceAgent[];
  onStop: (id: string) => void;
  onRestart: (id: string) => void;
  onGuide: (id: string, message: string) => Promise<void>;
  onArchive?: (id: string) => void;
  onRestore?: (id: string) => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const [guidance, setGuidance] = useState('');
  const [sendingGuidance, setSendingGuidance] = useState(false);
  const [expanded, setExpanded] = useState(run.status === 'running');
  useEffect(() => setExpanded(run.status === 'running'), [run.status]);
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
    <article className="task-card" id={`run-item-${run.id}`}>
      <div className="task-card-heading">
        {run.status === 'running'
          ? <div><h3>{run.name}</h3><span className="run-meta">{formatRelative(run.startedAt)} · {formatElapsed(run.startedAt, run.completedAt)}</span></div>
          : <button type="button" className="task-card-toggle" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><span><h3>{run.name}</h3><span className="run-meta">{formatRelative(run.startedAt)} · {formatElapsed(run.startedAt, run.completedAt)}</span></span>{expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</button>}
        <RunStatus status={run.status} />
      </div>
      {expanded && <>
      <details className="run-prompt"><summary>Task brief</summary><p>{run.prompt}</p></details>
      {!!runAgents.length && <section className="run-operations" aria-label="Subagent operations">
        <div className="run-tool-summary"><Users size={13} />{runAgents.filter(agent => agent.status === 'running').length} active of {runAgents.length} agents</div>
        {runAgents.map(agent => <div className="run-operation" key={agent.sessionId}>
          <ActivityOrb label={agent.activity ?? agent.status} compact loading={agent.status === 'running'} />
          <span><strong>{agent.task}</strong><small>{agent.activeTool ? `Executing ${agent.activeTool}` : agent.activity ?? agent.status}</small></span>
        </div>)}
        {runAgents.flatMap(agent => (agent.activityLog ?? []).slice(-3).map((entry, index) => ({ agent, entry, key: `${agent.sessionId}-${entry.timestamp}-${index}` }))).slice(-8).map(({ agent, entry, key }) => <div className="run-activity-entry run-activity-subagent" key={key}><span className={`run-activity-kind run-activity-${entry.kind}`} /><span><strong>{agent.task}</strong><small>{entry.label}</small></span><time>{new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time></div>)}
      </section>}
      {run.status === 'running' && <section className="run-operations" aria-label="Agent operations">
        <div className="run-operation">
          <ActivityOrb label={run.activity ?? 'Working'} compact loading />
          <span><strong>{run.activeTool ? `Executing ${run.activeTool}` : run.activity ?? 'Working'}</strong><small>Live agent activity</small></span>
        </div>
        {!!run.activityLog?.length && <ul className="run-activity-log" aria-label="Live activity log">
          {run.activityLog.slice(-10).reverse().map((entry, index) => <li className="run-activity-entry" key={`${entry.timestamp}-${index}`}>
            <span className={`run-activity-kind run-activity-${entry.kind}${entry.status === 'running' ? ' is-running' : ''}`} />
            <span><strong>{entry.label}</strong>{entry.toolName && <small>{entry.status === 'running' ? 'Running' : 'Complete'}</small>}</span>
            <time>{new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
          </li>)}
        </ul>}
      </section>}
      {run.error && <p className="run-result run-error"><CircleAlert size={14} />{run.error}</p>}
      {run.result && <div className="run-result"><strong>Agent result</strong><MessageBody content={run.result} /></div>}
      {!!run.toolNames?.length && <div className="run-tool-summary"><Wrench size={13} />{run.toolNames.join(', ')}</div>}
      {run.status === 'running' && <form className="task-guidance-form" onSubmit={event => { event.preventDefault(); void sendGuidance(guidance); }}>
        <textarea value={guidance} onChange={event => setGuidance(event.target.value)} maxLength={2_000} rows={2} placeholder="Guide or nudge the agent…" aria-label={`Guide task ${run.name}`} />
        <button type="submit" className="button button-secondary" disabled={sendingGuidance || !guidance.trim()}>{sendingGuidance ? <ActivityOrb label="Sending guidance" compact loading /> : <ArrowRight size={14} />}Guide</button>
      </form>}
      <div className="task-card-actions">
        <button className="button button-secondary" onClick={() => onOpenSession(run.sessionId)}><MessageSquare size={14} />Conversation</button>
        {run.status === 'running'
          ? <button className="button button-danger" onClick={() => onStop(run.id)}><X size={14} />Kill run</button>
          : <>
            {(run.status === 'cancelled' || run.status === 'failed') && <button className="button button-secondary" onClick={() => void sendGuidance('Continue this task from the existing conversation. Check what remains and complete the work.')}>Nudge</button>}
            <button className="button button-secondary" onClick={() => onRestart(run.id)}><RefreshCw size={14} />Restart</button>
          </>}
        {run.archivedAt
          ? <button className="button button-secondary" onClick={() => onRestore?.(run.id)}><Archive size={14} />Restore</button>
          : run.status !== 'running' && <button className="button button-secondary" onClick={() => onArchive?.(run.id)}><Archive size={14} />Archive</button>}
      </div>
      </>}
    </article>
  );
}

function WorkspaceDrawer({ openRequest, projectOpenRequest, projectToOpen, openThreadRequest, threadToOpen, onOpenIDE, onOpenTasks, projects, profiles, subagents, selectedProjectId, selectedAgentId, onSelectProject, onSelectAgent, onCreateProject, onCreateAgent, onOpenProfile, onOpenSubagent, onArchiveSubagent, onRestoreProject, onArchiveProject, onDeleteProject, onProjectUpdated, unreadThreadCount, onFailure, request }: {
  openRequest: number;
  projectOpenRequest: number;
  projectToOpen: string;
  openThreadRequest: number;
  threadToOpen: string;
  onOpenIDE: () => void;
  onOpenTasks: () => void;
  projects: WorkspaceProject[];
  profiles: AgentProfile[];
  subagents: WorkspaceAgent[];
  selectedProjectId: string;
  selectedAgentId: string;
  onSelectProject: (id: string) => void;
  onSelectAgent: (id: string) => void;
  onCreateProject: (name: string) => Promise<void>;
  onCreateAgent: (profile: { projectId: string; name: string; emoji: string; instructions: string }) => Promise<void>;
  onOpenProfile: (profile: AgentProfile) => void;
  onOpenSubagent: (id: string) => void;
  onArchiveSubagent: (id: string) => void;
  onRestoreProject: (id: string) => Promise<void>;
  onArchiveProject: (id: string) => Promise<boolean>;
  onDeleteProject: (id: string, name: string) => Promise<boolean>;
  onProjectUpdated: (project: WorkspaceProject) => void;
  unreadThreadCount: number;
  onFailure: (failure: unknown) => void;
  request: typeof api;
}) {
  const [section, setSection] = useState<'agents' | 'projects' | 'threads' | null>(null);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [agentName, setAgentName] = useState('');
  const [emoji, setEmoji] = useState('bot');
  const [instructions, setInstructions] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [archivedProjects, setArchivedProjects] = useState<WorkspaceProject[]>([]);
  const [showArchivedProjects, setShowArchivedProjects] = useState(false);
  const [projectDetailsId, setProjectDetailsId] = useState('');
  useEffect(() => {
    if (openRequest > 0) setSection('agents');
  }, [openRequest]);
  useEffect(() => {
    if (projectOpenRequest > 0) {
      setSection('projects');
      setProjectDetailsId(projectToOpen);
    }
  }, [projectOpenRequest, projectToOpen]);
  useEffect(() => {
    if (openThreadRequest > 0) setSection('threads');
  }, [openThreadRequest]);
  useEffect(() => {
    if (projectDetailsId && !projects.some(project => project.id === projectDetailsId)) setProjectDetailsId('');
  }, [projectDetailsId, projects]);
  const selectedProject = projects.find(project => project.id === selectedProjectId);
  const projectProfiles = profiles.filter(profile => profile.projectId === selectedProjectId);
  const projectSubagents = subagents.filter(agent => selectedProjectId ? agent.projectId === selectedProjectId : !agent.projectId);
  const toggleArchivedProjects = async () => {
    const show = !showArchivedProjects;
    setShowArchivedProjects(show);
    if (!show) return;
    setFormError('');
    try {
      const allProjects = await request<WorkspaceProject[]>('/api/projects?includeArchived=true');
      setArchivedProjects(allProjects.filter(project => Boolean(project.archivedAt)));
    } catch (failure) {
      setFormError(failure instanceof Error ? failure.message : 'Archived projects could not be loaded.');
      onFailure(failure);
    }
  };
  const restoreArchivedProject = async (id: string) => {
    setSaving(true);
    setFormError('');
    try {
      await onRestoreProject(id);
      setArchivedProjects(current => current.filter(project => project.id !== id));
    } catch (failure) {
      setFormError(failure instanceof Error ? failure.message : 'Project could not be restored.');
      onFailure(failure);
    } finally {
      setSaving(false);
    }
  };
  const deleteArchivedProject = async (project: WorkspaceProject) => {
    setSaving(true);
    setFormError('');
    try {
      if (await onDeleteProject(project.id, project.name)) {
        setArchivedProjects(current => current.filter(item => item.id !== project.id));
      }
    } catch (failure) {
      setFormError(failure instanceof Error ? failure.message : 'Archived project could not be deleted.');
      onFailure(failure);
    } finally {
      setSaving(false);
    }
  };
  const addProject = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setFormError('');
    try {
      await onCreateProject(projectName);
      setProjectName('');
    } catch (failure) {
      setFormError(failure instanceof Error ? failure.message : 'Project could not be created.');
      onFailure(failure);
    } finally {
      setSaving(false);
    }
  };
  const addAgent = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedProjectId) {
      setFormError('Create or select a project first.');
      return;
    }
    setSaving(true);
    setFormError('');
    try {
      await onCreateAgent({ projectId: selectedProjectId, name: agentName, emoji, instructions });
      setAgentName('');
      setInstructions('');
      setBuilderOpen(false);
    } catch (failure) {
      setFormError(failure instanceof Error ? failure.message : 'Agent could not be created.');
      onFailure(failure);
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <aside className="workspace-rail" aria-label="Agents, projects, tasks and threads">
        <button type="button" className={section === 'agents' ? 'workspace-rail-button rail-active' : 'workspace-rail-button'} onClick={() => setSection(current => current === 'agents' ? null : 'agents')} aria-label="Open agents" aria-expanded={section === 'agents'} title="Agents"><Users size={17} /></button>
        <button type="button" className={section === 'projects' ? 'workspace-rail-button rail-active' : 'workspace-rail-button'} onClick={() => setSection(current => current === 'projects' ? null : 'projects')} aria-label="Open projects" aria-expanded={section === 'projects'} title="Projects"><FolderOpen size={17} /></button>
        <button type="button" className="workspace-rail-button" onClick={() => { setSection(null); onOpenTasks(); }} aria-label="Open task board and scheduled jobs" title="Tasks and scheduled jobs"><Activity size={17} /></button>
        <button type="button" className={section === 'threads' ? 'workspace-rail-button rail-active' : 'workspace-rail-button'} onClick={() => setSection(current => current === 'threads' ? null : 'threads')} aria-label={`Open agent collaboration threads${unreadThreadCount ? `, ${unreadThreadCount} unread help requests` : ''}`} aria-expanded={section === 'threads'} title="Agent threads"><MessagesSquare size={17} />{unreadThreadCount > 0 && <span className="workspace-rail-unread-dot" aria-label={`${unreadThreadCount} unread help requests`} />}</button>
      </aside>
      <section className="workspace-drawer" data-open={section !== null} aria-label={section === 'projects' ? 'Projects' : section === 'threads' ? 'Agent threads' : 'Agents'} aria-hidden={section === null} inert={section === null}>
        <header className="workspace-drawer-header">
          <div><span className="eyebrow">{section === 'projects' ? 'WORKSPACES' : section === 'threads' ? 'MULTI-AGENT COLLABORATION' : 'WORKSPACE AGENTS'}</span><h2>{section === 'projects' ? 'Projects' : section === 'threads' ? 'Threads' : 'Agents'}</h2></div>
          <button className="icon-button small" type="button" onClick={() => setSection(null)} aria-label="Close workspace drawer"><X size={15} /></button>
        </header>
        {section === 'projects' ? (
          projectDetailsId && projects.some(project => project.id === projectDetailsId) ? (
            <>
              <button type="button" className="text-button project-management-back" onClick={() => setProjectDetailsId('')}><ArrowRight size={13} />All projects</button>
              {projects.filter(project => project.id === projectDetailsId).map(project => <ProjectsPanel
                key={project.id}
                project={project}
                profiles={profiles.filter(profile => profile.projectId === project.id)}
                agents={subagents}
                request={request}
                onArchive={onArchiveProject}
                onOpenIDE={() => { setSection(null); onOpenIDE(); }}
                onProjectUpdated={onProjectUpdated}
              />)}
            </>
          ) : <>
            <div className="workspace-drawer-list">
              {projects.map(project => <button key={project.id} className={`drawer-project${project.id === selectedProjectId ? ' drawer-item-active' : ''}`} type="button" onClick={() => setProjectDetailsId(project.id)}>
                <FolderOpen size={16} /><span><strong>{project.name}</strong><small>{profiles.filter(profile => profile.projectId === project.id).length} agents</small></span>
              </button>)}
              {projects.length === 0 && <p className="drawer-empty">No projects yet. Create one to give agents a dedicated workspace.</p>}
            </div>
            <button className="text-button drawer-archived-toggle" type="button" onClick={() => void toggleArchivedProjects()} aria-expanded={showArchivedProjects}>
              {showArchivedProjects ? 'Hide archived projects' : 'Show archived projects'}
            </button>
            {showArchivedProjects && <div className="workspace-drawer-list archived-project-list">
              {archivedProjects.map(project => <div key={project.id} className="drawer-archived-project">
                <span><strong>{project.name}</strong><small>Archived {formatRelative(project.archivedAt ?? project.createdAt)}</small></span>
                <button type="button" className="icon-button small" onClick={() => void restoreArchivedProject(project.id)} disabled={saving} aria-label={`Restore ${project.name}`} title="Restore project"><RefreshCw size={14} /></button>
                <button type="button" className="icon-button small" onClick={() => void deleteArchivedProject(project)} disabled={saving} aria-label={`Permanently delete ${project.name}`} title="Permanently delete project"><X size={14} /></button>
              </div>)}
              {archivedProjects.length === 0 && <p className="drawer-empty">No archived projects.</p>}
            </div>}
            <form className="drawer-create-form" onSubmit={event => void addProject(event)}>
              <label htmlFor="new-project-name">New project</label>
              <div><input id="new-project-name" value={projectName} onChange={event => setProjectName(event.target.value)} maxLength={80} placeholder="Project name" required /><button className="button button-primary" type="submit" disabled={saving || !projectName.trim()} aria-label="Create project"><Plus size={15} /></button></div>
              {formError && <p role="alert">{formError}</p>}
            </form>
          </>
        ) : section === 'threads' ? (
          <ThreadsPanel request={request} projects={projects} profiles={profiles} selectedProjectId={selectedProjectId} requestedThreadId={threadToOpen} />
        ) : (
          <>
            <div className="drawer-project-picker">
              <label htmlFor="agent-project-select">Project workspace</label>
              <select id="agent-project-select" value={selectedProjectId} onChange={event => onSelectProject(event.target.value)}>
                <option value="">Home · default workspace</option>
                {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
            </div>
            <div className="workspace-drawer-list">
              {projectProfiles.map(profile => <button key={profile.id} className={`drawer-agent${profile.id === selectedAgentId ? ' drawer-item-active' : ''}`} type="button" onClick={() => { onSelectAgent(profile.id); onOpenProfile(profile); }}>
                <span className="drawer-agent-avatar"><AgentGlyph id={profile.emoji} size={16} /></span><span><strong>{profile.name}</strong><small>{selectedProject?.name ?? 'Project agent'}</small></span><ArrowRight size={14} />
              </button>)}
              {projectProfiles.length === 0 && <p className="drawer-empty">No agents in this project. Use + to create one.</p>}
            </div>
            <section className="drawer-subagents">
              <h3>Subagents</h3>
              {projectSubagents.map(agent => <div className="drawer-subagent" key={agent.sessionId}>
                <button type="button" className="drawer-subagent-open" onClick={() => onOpenSubagent(agent.sessionId)} title="Open subagent conversation"><Bot size={15} /><span><strong>{agent.task}</strong><small>{agent.status}</small></span></button>
                {agent.status !== 'running' && <button type="button" className="icon-button small" onClick={() => onArchiveSubagent(agent.sessionId)} aria-label={`Archive ${agent.task}`} title="Archive subagent"><Archive size={14} /></button>}
              </div>)}
              {projectSubagents.length === 0 && <p className="drawer-empty">Subagents created by these project sessions appear here.</p>}
            </section>
            <button className="workspace-agent-add" type="button" onClick={() => { setFormError(''); setBuilderOpen(true); }} disabled={!selectedProjectId} aria-label="Create agent" title="Create agent"><Plus size={20} /></button>
          </>
        )}
      </section>
      {builderOpen && <div className="identity-backdrop" onMouseDown={() => setBuilderOpen(false)}>
        <section className="identity-dialog agent-builder-dialog" role="dialog" aria-modal="true" aria-labelledby="agent-builder-title" onMouseDown={event => event.stopPropagation()}>
          <header className="identity-dialog-header"><span className="identity-dialog-icon"><Users size={19} /></span><div><div className="eyebrow">NEW WORKSPACE AGENT</div><h2 id="agent-builder-title">Build an agent</h2></div><button className="icon-button small" type="button" onClick={() => setBuilderOpen(false)} aria-label="Close agent builder"><X size={16} /></button></header>
          <form onSubmit={event => void addAgent(event)}>
            <label className="identity-field"><span>Agent name</span><input value={agentName} onChange={event => setAgentName(event.target.value)} maxLength={80} required /></label>
            <fieldset className="identity-field"><legend>Avatar</legend><AgentIconPicker id="workspace-agent-icon" value={emoji} onChange={setEmoji} /></fieldset>
            <label className="identity-field"><span>Role, behavior, and operating instructions</span><textarea value={instructions} onChange={event => setInstructions(event.target.value)} maxLength={20_000} rows={12} required placeholder="Describe what this agent does, how it should work, and its boundaries." /></label>
            <p className="drawer-builder-note">Creates a project-scoped workspace and a separate conversation history. The gateway’s configured tool and security policy still applies.</p>
            {formError && <div className="notice notice-error" role="alert">{formError}</div>}
            <footer className="identity-dialog-actions"><button className="button button-secondary" type="button" onClick={() => setBuilderOpen(false)}>Cancel</button><button className="button button-primary" type="submit" disabled={saving || !agentName.trim() || !instructions.trim()}>{saving ? <ActivityOrb label="Creating agent" compact loading /> : <Check size={14} />}{saving ? 'Creating' : 'Create agent'}</button></footer>
          </form>
        </section>
      </div>}
    </>
  );
}

function AgentsView({ agents, profiles, projects, onControl, onOpenProfile, onCreateAgent }: {
  agents: WorkspaceAgent[];
  profiles: AgentProfile[];
  projects: WorkspaceProject[];
  onControl: (id: string, action: 'stop' | 'steer', message?: string) => Promise<void>;
  onOpenProfile: (profile: AgentProfile) => void;
  onCreateAgent: (profile: { projectId: string; name: string; emoji: string; instructions: string }) => Promise<void>;
}) {
  const [builderOpen, setBuilderOpen] = useState(false);
  const [projectId, setProjectId] = useState('');
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('bot');
  const [instructions, setInstructions] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const running = agents.filter(agent => agent.status === 'running').length;
  const completed = agents.filter(agent => agent.status === 'completed').length;
  const failed = agents.filter(agent => agent.status === 'failed' || agent.status === 'killed').length;
  const createAgent = async (event: FormEvent) => {
    event.preventDefault();
    if (!projectId || !name.trim() || !instructions.trim()) return;
    setSaving(true);
    setError('');
    try {
      await onCreateAgent({ projectId, name: name.trim(), emoji, instructions: instructions.trim() });
      setName('');
      setInstructions('');
      setBuilderOpen(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Agent could not be created.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page management-page agents-page">
      <PageHeading
        eyebrow="AGENT MANAGEMENT"
        title="Agents"
        detail="Manage project-scoped agent profiles and monitor live workers, delegation, and recent execution activity."
        action={<button type="button" className="button button-primary" onClick={() => { setError(''); setProjectId(current => current || projects[0]?.id || ''); setBuilderOpen(true); }} disabled={!projects.length}><Plus size={14} />Create agent</button>}
      />
      <section className="management-stats" aria-label="Agent telemetry">
        <ManagementStat icon={Users} label="Workspace agents" value={profiles.length} detail={`${projects.length} project${projects.length === 1 ? '' : 's'} available`} />
        <ManagementStat icon={Activity} label="Running workers" value={running} detail="Live delegated sessions" tone={running ? 'green' : 'neutral'} />
        <ManagementStat icon={CircleCheck} label="Completed workers" value={completed} detail="Finished delegated sessions" />
        <ManagementStat icon={CircleAlert} label="Needs attention" value={failed} detail="Failed or stopped workers" tone={failed ? 'orange' : 'neutral'} />
      </section>
      {error && <div className="notice notice-error" role="alert">{error}</div>}
      <section className="management-section" aria-labelledby="agent-profiles-title">
        <header className="management-section-heading"><div><span className="eyebrow">CONFIGURED WORKERS</span><h2 id="agent-profiles-title">Workspace agents</h2><p>Persistent agents assigned to projects, with their own instructions and conversation history.</p></div><span className="management-section-count">{profiles.length}</span></header>
        {profiles.length ? <div className="agent-profile-grid">
          {profiles.slice().sort((left, right) => right.createdAt - left.createdAt).map(profile => {
            const profileRuns = agents.filter(agent => agent.agentId === profile.id).sort((left, right) => right.startedAt - left.startedAt);
            const activeRuns = profileRuns.filter(agent => agent.status === 'running').length;
            const project = projects.find(item => item.id === profile.projectId);
            return <article className="surface-card agent-profile-card" key={profile.id}>
              <header>
                <span className="agent-profile-avatar"><AgentGlyph id={profile.emoji} size={19} /></span>
                <span className="agent-profile-heading"><strong>{profile.name}</strong><small>{project?.name ?? 'Project unavailable'}</small></span>
                <span className={`agent-profile-status${activeRuns ? ' is-active' : ''}`}><i />{activeRuns ? `${activeRuns} active` : 'Standby'}</span>
              </header>
              <p className="agent-profile-instructions">{profile.instructions}</p>
              <div className="agent-profile-telemetry"><span><strong>{profileRuns.length}</strong> runs</span><span><strong>{profileRuns.filter(agent => agent.status === 'completed').length}</strong> completed</span><span>Created {formatRelative(profile.createdAt)}</span></div>
              {profileRuns[0] && <div className="agent-profile-last-run"><span className={`run-activity-kind run-activity-${profileRuns[0].status === 'failed' || profileRuns[0].status === 'killed' ? 'tool' : profileRuns[0].status === 'running' ? 'thinking' : 'todo'}`} /><span><strong>{profileRuns[0].task}</strong><small>{profileRuns[0].activeTool ? `Using ${profileRuns[0].activeTool}` : profileRuns[0].activity ?? profileRuns[0].status}</small></span></div>}
              <footer><button type="button" className="button button-secondary" onClick={() => onOpenProfile(profile)}><MessageSquare size={13} />Open agent workspace</button></footer>
            </article>;
          })}
        </div> : <section className="surface-card management-empty"><EmptyState icon={Users} title="No workspace agents yet" detail={projects.length ? 'Create a project-scoped agent to give recurring work a stable identity and dedicated instructions.' : 'Create a project first; agents are scoped to a project workspace.'} /></section>}
      </section>
      <section className="management-section" aria-labelledby="agent-workers-title">
        <header className="management-section-heading"><div><span className="eyebrow">EXECUTION TELEMETRY</span><h2 id="agent-workers-title">Delegated workers</h2><p>Live subagents and their recent activity, controls, results, and parent-session context.</p></div><span className="management-section-count">{agents.length}</span></header>
        <div className="agent-capability-note"><Users size={16} /><span>Subagents run in isolated sessions with commands defaulting to their assigned workspace. Tool access follows the parent agent’s tier and gateway policy. Steering sends guidance; stop cancels an active agent.</span></div>
        {agents.length ? <section className="agent-list">{agents.slice().sort((a, b) => b.startedAt - a.startedAt).map(agent => <AgentCard key={agent.sessionId} agent={agent} onControl={onControl} />)}</section> : (
          <section className="surface-card management-empty"><EmptyState icon={Activity} title="No delegated workers" detail="When an agent delegates a task, its live session and telemetry will appear here." /></section>
        )}
      </section>
      {builderOpen && <div className="identity-backdrop" onMouseDown={() => setBuilderOpen(false)}>
        <section className="identity-dialog agent-builder-dialog" role="dialog" aria-modal="true" aria-labelledby="agent-manager-builder-title" onMouseDown={event => event.stopPropagation()}>
          <header className="identity-dialog-header"><span className="identity-dialog-icon"><Users size={19} /></span><div><div className="eyebrow">NEW WORKSPACE AGENT</div><h2 id="agent-manager-builder-title">Build an agent</h2></div><button className="icon-button small" type="button" onClick={() => setBuilderOpen(false)} aria-label="Close agent builder"><X size={16} /></button></header>
          <form onSubmit={event => void createAgent(event)}>
            <label className="identity-field"><span>Project workspace</span><select value={projectId} onChange={event => setProjectId(event.target.value)} required><option value="">Select a project</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
            <label className="identity-field"><span>Agent name</span><input value={name} onChange={event => setName(event.target.value)} maxLength={80} required /></label>
            <fieldset className="identity-field"><legend>Avatar</legend><AgentIconPicker id="agent-manager-icon" value={emoji} onChange={setEmoji} /></fieldset>
            <label className="identity-field"><span>Role, behavior, and operating instructions</span><textarea value={instructions} onChange={event => setInstructions(event.target.value)} maxLength={20_000} rows={10} required placeholder="Describe what this agent does, how it should work, and its boundaries." /></label>
            <p className="drawer-builder-note">Creates a project-scoped workspace and a separate conversation history. The gateway’s configured tool and security policy still applies.</p>
            {error && <div className="notice notice-error" role="alert">{error}</div>}
            <footer className="identity-dialog-actions"><button className="button button-secondary" type="button" onClick={() => setBuilderOpen(false)}>Cancel</button><button className="button button-primary" type="submit" disabled={saving || !projectId || !name.trim() || !instructions.trim()}>{saving ? <ActivityOrb label="Creating agent" compact loading /> : <Check size={14} />}{saving ? 'Creating' : 'Create agent'}</button></footer>
          </form>
        </section>
      </div>}
    </div>
  );
}

function ManagementStat({ icon: Icon, label, value, detail, tone = 'neutral' }: {
  icon: typeof Activity;
  label: string;
  value: number | string;
  detail: string;
  tone?: 'neutral' | 'green' | 'orange';
}) {
  return <div className={`management-stat management-stat-${tone}`}><span><Icon size={15} /></span><div><small>{label}</small><strong>{value}</strong><em>{detail}</em></div></div>;
}

function ProjectsView({ projects, profiles, agents, selectedProjectId, onSelectProject, onCreateProject, onRestoreProject, onArchiveProject, onDeleteProject, onProjectUpdated, request, onOpenIDE }: {
  projects: WorkspaceProject[];
  profiles: AgentProfile[];
  agents: WorkspaceAgent[];
  selectedProjectId: string;
  onSelectProject: (id: string) => void;
  onCreateProject: (name: string) => Promise<void>;
  onRestoreProject: (id: string) => Promise<void>;
  onArchiveProject: (id: string) => Promise<boolean>;
  onDeleteProject: (id: string, name: string) => Promise<boolean>;
  onProjectUpdated: (project: WorkspaceProject) => void;
  request: typeof api;
  onOpenIDE: () => void;
}) {
  const [projectName, setProjectName] = useState('');
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [archivedProjects, setArchivedProjects] = useState<WorkspaceProject[]>([]);
  const [archivedLoaded, setArchivedLoaded] = useState(false);
  const [loadingArchived, setLoadingArchived] = useState(false);
  const [error, setError] = useState('');
  const selectedProject = projects.find(project => project.id === selectedProjectId);
  const activeProjects = projects.filter(project => !project.archivedAt);
  const activeAgentCount = agents.filter(agent => agent.status === 'running').length;

  const toggleArchived = async () => {
    const nextOpen = !showArchived;
    setShowArchived(nextOpen);
    if (!nextOpen) return;
    setLoadingArchived(true);
    setError('');
    try {
      const all = await request<WorkspaceProject[]>('/api/projects?includeArchived=true');
      setArchivedProjects(all.filter(project => Boolean(project.archivedAt)));
      setArchivedLoaded(true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Archived projects could not be loaded.');
    } finally {
      setLoadingArchived(false);
    }
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!projectName.trim()) return;
    setCreating(true);
    setError('');
    try {
      await onCreateProject(projectName.trim());
      setProjectName('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Project could not be created.');
    } finally {
      setCreating(false);
    }
  };

  const restore = async (id: string) => {
    setError('');
    try {
      await onRestoreProject(id);
      setArchivedProjects(current => current.filter(project => project.id !== id));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Project could not be restored.');
    }
  };

  const removeArchived = async (project: WorkspaceProject) => {
    setError('');
    if (await onDeleteProject(project.id, project.name)) {
      setArchivedProjects(current => current.filter(item => item.id !== project.id));
    }
  };

  return (
    <div className="page management-page projects-page">
      <PageHeading
        eyebrow="PROJECT MANAGEMENT"
        title="Projects"
        detail="Organize agent workspaces, define scope and success criteria, and manage project tasks, agents, and execution."
        action={<button type="button" className="button button-secondary" onClick={() => void toggleArchived()} aria-expanded={showArchived}><Archive size={14} />{showArchived ? 'Hide archived' : 'Archived projects'}</button>}
      />
      <section className="management-stats" aria-label="Project overview">
        <ManagementStat icon={FolderOpen} label="Active projects" value={activeProjects.length} detail="Dedicated workspaces" />
        <ManagementStat icon={Users} label="Workspace agents" value={profiles.length} detail="Project-scoped profiles" />
        <ManagementStat icon={Activity} label="Running workers" value={activeAgentCount} detail="Active delegated sessions" tone={activeAgentCount ? 'green' : 'neutral'} />
        <ManagementStat icon={Archive} label="Archived projects" value={archivedLoaded ? archivedProjects.length : '—'} detail={archivedLoaded ? 'Retained workspaces' : 'Load from the archive view'} />
      </section>
      {error && <div className="notice notice-error" role="alert">{error}</div>}
      {selectedProject ? (
        <section className="project-page-detail">
          <button type="button" className="text-button project-management-back" onClick={() => onSelectProject('')}><ArrowRight size={13} />All projects</button>
          <Suspense fallback={<div className="loading-state"><ActivityOrb label="Loading project management" loading /><span>Loading project details…</span></div>}>
            <ProjectsPanel
              key={selectedProject.id}
              project={selectedProject}
              profiles={profiles.filter(profile => profile.projectId === selectedProject.id)}
              agents={agents}
              request={request}
              onArchive={onArchiveProject}
              onOpenIDE={onOpenIDE}
              onProjectUpdated={onProjectUpdated}
            />
          </Suspense>
        </section>
      ) : (
        <>
          <form className="project-create-bar" onSubmit={event => void create(event)}>
            <div><span className="eyebrow">NEW WORKSPACE</span><strong>Create a project</strong><small>Projects group files, conversations, agent profiles, and work items.</small></div>
            <label className="sr-only" htmlFor="management-project-name">Project name</label>
            <input id="management-project-name" value={projectName} onChange={event => setProjectName(event.target.value)} maxLength={80} placeholder="Give this workspace a name…" required />
            <button className="button button-primary" type="submit" disabled={creating || !projectName.trim()}>{creating ? <ActivityOrb label="Creating project" compact loading /> : <Plus size={14} />}Create project</button>
          </form>
          <section className="management-section" aria-labelledby="projects-index-title">
            <header className="management-section-heading"><div><span className="eyebrow">WORKSPACE DIRECTORY</span><h2 id="projects-index-title">Active projects</h2><p>Select a project to manage its scope, agent roster, and task plan.</p></div><span className="management-section-count">{activeProjects.length}</span></header>
            {activeProjects.length ? <div className="project-management-grid">
              {activeProjects.map(project => {
                const projectProfiles = profiles.filter(profile => profile.projectId === project.id);
                const projectAgents = agents.filter(agent => agent.projectId === project.id);
                const projectRunning = projectAgents.filter(agent => agent.status === 'running').length;
                return <button className="surface-card project-index-card" type="button" key={project.id} onClick={() => onSelectProject(project.id)}>
                  <span className="project-index-icon"><FolderOpen size={18} /></span>
                  <span className="project-index-copy"><strong>{project.name}</strong><small>{project.scope || 'No scope defined'}</small></span>
                  <span className="project-index-metrics"><span><Users size={13} />{projectProfiles.length}</span><span><Activity size={13} />{projectRunning} active</span></span>
                  <span className="project-index-date">Created {formatRelative(project.createdAt)}</span>
                  <ArrowRight size={15} className="project-index-open" />
                </button>;
              })}
            </div> : <section className="surface-card management-empty"><EmptyState icon={FolderOpen} title="No active projects" detail="Create a workspace above to organize files, agent profiles, and work plans." /></section>}
          </section>
          {showArchived && <section className="management-section" aria-labelledby="archived-projects-title">
            <header className="management-section-heading"><div><span className="eyebrow">RETAINED WORKSPACES</span><h2 id="archived-projects-title">Archived projects</h2><p>Restore a project to resume work or permanently remove its retained workspace and sessions.</p></div><span className="management-section-count">{loadingArchived ? '…' : archivedProjects.length}</span></header>
            {loadingArchived ? <div className="loading-state"><ActivityOrb label="Loading archived projects" loading /><span>Loading archived projects…</span></div> : archivedProjects.length ? <div className="archived-project-cards">
              {archivedProjects.map(project => <article className="surface-card archived-project-card" key={project.id}><div><strong>{project.name}</strong><small>Archived {formatRelative(project.archivedAt ?? project.createdAt)}</small></div><button className="button button-secondary" type="button" onClick={() => void restore(project.id)}><RefreshCw size={13} />Restore</button><button className="icon-button small" type="button" onClick={() => void removeArchived(project)} aria-label={`Permanently delete ${project.name}`} title="Permanently delete"><X size={14} /></button></article>)}
            </div> : <p className="management-empty-note">No archived projects.</p>}
          </section>}
        </>
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
    <article className="surface-card agent-card" id={`agent-item-${agent.sessionId}`}>
      <div className="run-card-heading"><div><h3>{agent.task}</h3><span className="run-meta">Agent {agent.sessionId} · {formatElapsed(agent.startedAt, agent.completedAt)}</span></div><span className={`run-status run-status-${agent.status === 'completed' ? 'completed' : agent.status === 'running' ? 'running' : 'failed'}`}>{agent.status}</span></div>
      {isRunning && <div className="run-operation agent-current-activity"><ActivityOrb state={getActivityOrbState(getActivityFromStatus(agent.activity, agent.activeTool))} label={agent.activity ?? 'Thinking'} compact /><span><strong>{agent.activeTool ? `Executing ${agent.activeTool}` : agent.activity ?? 'Thinking'}</strong><small>Live agent activity</small></span></div>}
      {agent.parentSessionId && <div className="agent-parent">Parent session <code>{agent.parentSessionId}</code></div>}
      {!!agent.activityLog?.length && <ul className="run-activity-log agent-activity-log" aria-label="Recent agent activity">
        {agent.activityLog.slice(-5).reverse().map((entry, index) => <li className="run-activity-entry" key={`${entry.timestamp}-${index}`}>
          <span className={`run-activity-kind run-activity-${entry.kind}${entry.status === 'running' ? ' is-running' : ''}`} />
          <span><strong>{entry.label}</strong>{entry.toolName && <small>{entry.status === 'running' ? 'Running' : 'Complete'}</small>}</span>
          <time>{new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
        </li>)}
      </ul>}
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
    const now = Date.now();
    setClock(current => {
      const estimatedSeconds = current.seconds + (now - current.syncedAt) / 1000;
      return Math.abs(seconds - estimatedSeconds) < 2
        ? current
        : { seconds, syncedAt: now, now };
    });
  }, [seconds]);
  useEffect(() => {
    const timer = window.setInterval(() => setClock(current => ({ ...current, now: Date.now() })), 250);
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
    let timer: number;
    const updateAtNextSecond = () => {
      const current = new Date();
      setNow(current);
      timer = window.setTimeout(updateAtNextSecond, 1000 - current.getMilliseconds());
    };
    timer = window.setTimeout(updateAtNextSecond, 1000 - Date.now() % 1000);
    return () => window.clearTimeout(timer);
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
    { name: 'Symbiote', value: process, color: 'var(--appearance-icon)' },
    { name: 'Other used', value: other, color: '#d18a68' },
    { name: 'Available', value: available, color: '#c9cabe' },
  ];
  let offset = 0;
  return (
    <MetricCard icon={HardDrive} label="RAM" tone="blue">
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

function GpuUsageCard({ host, hostHistory }: { host?: HostResourceSnapshot; hostHistory: HostResourceSnapshot[] }) {
  const gpu = host?.gpu;
  if (!gpu || gpu.state === 'detecting') {
    return <MetricCard icon={Cpu} label="GPU" tone="neutral">
      <strong className="metric-value">Detecting</strong>
    </MetricCard>;
  }
  if (gpu.state === 'unavailable') {
    return <MetricCard icon={Cpu} label="GPU" tone="neutral">
      <strong className="metric-value">Unavailable</strong>
    </MetricCard>;
  }
  const names = gpu.devices.map(device => device.name).join(' · ');
  const gpuHistory = hostHistory.filter(sample => sample.gpu.state === 'available');
  return <MetricCard icon={Cpu} label="GPU" tone="blue">
    <div className="gpu-device-name" title={names}>{names || 'GPU detected'}</div>
    <div className="metric-memory-reading">
      <strong>{gpu.loadPercent === null ? '—' : `${gpu.loadPercent.toFixed(1)}%`}</strong>
      <span>{gpu.loadPercent === null ? 'Load unavailable' : 'Load'}</span>
    </div>
    <div className="metric-reading-subtext">
      {gpu.dedicatedMemoryUsedBytes === null
        ? gpu.sharedMemoryUsedBytes === null
          ? 'Memory unavailable'
            : `${formatSystemBytes(gpu.sharedMemoryUsedBytes)} shared`
          : `${formatSystemBytes(gpu.dedicatedMemoryUsedBytes)} / ${gpu.dedicatedMemoryTotalBytes === null ? '—' : formatSystemBytes(gpu.dedicatedMemoryTotalBytes)}`}
      {gpu.sharedMemoryUsedBytes !== null && gpu.dedicatedMemoryUsedBytes !== null
        ? ` · ${formatSystemBytes(gpu.sharedMemoryUsedBytes)} shared`
        : ''}
    </div>
    {gpu.loadPercent === null
      ? <div className="gpu-telemetry-note">{gpu.unavailableReason ?? 'Load telemetry unavailable'}</div>
      : <MetricPlot
        label="GPU peak engine utilization over time"
        area
        maxValue={100}
        series={[{ name: 'GPU load', color: '', values: gpuHistory.map(sample => sample.gpu.loadPercent ?? 0) }]}
      />}
  </MetricCard>;
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
  const colorForSeries = (name: string, index: number) => {
    if (name === 'Core 1') return '#ef4444';
    if (index === 0) return 'var(--appearance-primary)';
    if (index === 1) return 'var(--appearance-icon)';
    let hash = 2166136261;
    for (let character = 0; character < name.length; character++) {
      hash = Math.imul(hash ^ name.charCodeAt(character), 16777619);
    }
    return `hsl(${(hash >>> 0) % 360} 68% 58%)`;
  };
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
        {series.map((item, index) => {
          const color = colorForSeries(item.name, index);
          return <g key={item.name}>
            {area && index === 0 && <path d={pathFor(item.values, true)} fill={color} fillOpacity=".15" />}
            <path d={pathFor(item.values)} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          </g>;
        })}
      </svg>
      {series.length > 1 && <div className="metric-plot-legend">{series.map((item, index) => <span key={item.name}><i style={{ background: colorForSeries(item.name, index) }} />{item.name}</span>)}</div>}
    </div>
  );
}

function ChannelTile({ channel, onRestart, qr }: {
  channel: GatewayStatus['channels'][number];
  onRestart?: (channelType: string) => void;
  qr?: GatewayStatus['whatsappQr'];
}) {
  const online = channel.status === 'running' || channel.health?.state === 'connected';
  const [qrOpen, setQrOpen] = useState(false);
  const [qrImage, setQrImage] = useState('');
  useEffect(() => {
    let cancelled = false;
    if (!qr?.value || channel.channelType !== 'whatsapp') {
      setQrImage('');
      return;
    }
    void import('qrcode').then(module => module.toDataURL(qr.value, { width: 220, margin: 2 }))
      .then(image => { if (!cancelled) setQrImage(image); })
      .catch(error => console.error('Could not render the WhatsApp pairing QR:', error));
    return () => { cancelled = true; };
  }, [channel.channelType, qr?.updatedAt, qr?.value]);
  const normalizedType = channel.channelType.toLowerCase();
  return (
    <div className="channel-tile">
      <span className={`channel-symbol channel-symbol-${normalizedType}${online ? ' channel-symbol-live' : ''}`}><ChannelBrandMark channelType={channel.channelType} /></span>
      <span className="channel-copy"><strong>{channel.id}</strong><small>{channel.channelType}</small></span>
      <span className={`channel-health-light${online ? ' channel-health-light-online' : ''}`} title={online ? 'Connected' : channel.status || 'Offline'} aria-label={online ? 'Connected' : channel.status || 'Offline'} />
      {onRestart && ['discord', 'whatsapp'].includes(normalizedType) && <button className="icon-button small channel-restart-button" type="button" onClick={() => onRestart(channel.channelType)} aria-label={`Restart ${channel.channelType} adapter`} title={`Restart ${channel.channelType}`}><RefreshCw size={13} /></button>}
      {normalizedType === 'whatsapp' && <button className="icon-button small channel-qr-toggle" type="button" onClick={() => setQrOpen(open => !open)} aria-label={`${qrOpen ? 'Hide' : 'Show'} WhatsApp QR code`} aria-expanded={qrOpen}><ChevronDown size={14} /></button>}
      {normalizedType === 'whatsapp' && qrOpen && <div className="channel-qr-panel">
        {qrImage ? <img src={qrImage} alt={`WhatsApp pairing QR updated ${new Date(qr?.updatedAt ?? 0).toLocaleTimeString()}`} /> : <span>{channel.status === 'not-configured' ? 'WhatsApp is not configured.' : 'Waiting for a new WhatsApp QR code…'}</span>}
      </div>}
    </div>
  );
}

function ChannelBrandMark({ channelType }: { channelType: string }) {
  const type = channelType.toLowerCase();
  if (type === 'discord') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.73 5.1a18.1 18.1 0 0 0-4.46-1.38l-.55 1.12a16.7 16.7 0 0 0-5.43 0l-.56-1.12A18.2 18.2 0 0 0 4.27 5.1C1.45 9.3.69 13.4 1.07 17.44a18.3 18.3 0 0 0 5.46 2.77l1.18-1.92c-.65-.24-1.27-.55-1.86-.9l.46-.36c3.59 1.66 7.49 1.66 11.04 0l.47.36c-.6.35-1.22.66-1.87.9l1.18 1.92a18.2 18.2 0 0 0 5.46-2.77c.45-4.68-.77-8.74-3.36-12.34ZM8.64 14.83c-1.08 0-1.97-.99-1.97-2.2s.87-2.2 1.97-2.2c1.1 0 1.99 1 1.97 2.2 0 1.21-.87 2.2-1.97 2.2Zm6.72 0c-1.08 0-1.97-.99-1.97-2.2s.87-2.2 1.97-2.2c1.1 0 1.99 1 1.97 2.2 0 1.21-.87 2.2-1.97 2.2Z" /></svg>;
  if (type === 'whatsapp') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12.04 2a9.94 9.94 0 0 0-8.53 15.05L2 22l5.1-1.47A9.94 9.94 0 1 0 12.04 2Zm0 18.06a8.08 8.08 0 0 1-4.12-1.13l-.3-.18-3.03.87.88-2.95-.2-.31a8.1 8.1 0 1 1 6.77 3.7Zm4.44-6.07c-.24-.12-1.44-.71-1.66-.79-.22-.08-.38-.12-.54.12-.16.24-.62.79-.76.95-.14.16-.28.18-.52.06-.24-.12-1.02-.38-1.94-1.2-.72-.64-1.2-1.43-1.34-1.67-.14-.24-.02-.37.1-.49.11-.11.24-.28.36-.42.12-.14.16-.24.24-.4.08-.16.04-.3-.02-.42-.06-.12-.54-1.3-.74-1.78-.19-.46-.39-.4-.54-.41h-.46c-.16 0-.42.06-.64.3-.22.24-.84.82-.84 2s.86 2.32.98 2.48c.12.16 1.7 2.6 4.11 3.64.57.25 1.02.4 1.37.51.58.18 1.1.16 1.51.1.46-.07 1.44-.59 1.64-1.16.2-.57.2-1.06.14-1.16-.06-.1-.22-.16-.46-.28Z" /></svg>;
  return <Network size={15} aria-hidden="true" />;
}

function ChatView(props: {
  session?: SessionSummary;
  sessions: SessionSummary[];
  messages: ChatMessage[];
  agentName?: string;
  agentEmoji?: string;
  agentAvatarDataUrl?: string;
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
  const { session, sessions, messages, agentName, agentEmoji, agentAvatarDataUrl, draft, sending, onDraft, onSubmit, onStop, onNewSession, onSelectSession, onArchiveSession, bottomRef, creatingSession } = props;
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
          <button className="button button-secondary export-button" onClick={exportSession} disabled={!session || !messages.length} title="Export conversation" aria-label="Export conversation"><Download size={15} /></button>
          <button className="button button-secondary" onClick={() => session && void onArchiveSession(session.id)} disabled={!session} title="Archive conversation" aria-label="Archive conversation"><Archive size={15} /></button>
          <button className="button button-primary" onClick={onNewSession} disabled={creatingSession} title="New conversation" aria-label="New conversation"><Plus size={16} /></button>
        </div>}
      />
      <section className="chat-shell" aria-label="Conversation">
        <div className="chat-stream" aria-live="polite" aria-relevant="additions text">
          {messages.length ? messages.map(message => (
            <article key={message.id} className={`message-row message-${message.role}`}>
              <div className={`message-avatar${message.role === 'assistant' ? ' message-avatar-agent' : ''}`} aria-hidden="true">
                {message.role === 'assistant'
                  ? session?.sessionKind === 'subagent' ? <Bot size={17} /> : <AgentAvatar emoji={agentEmoji} image={agentAvatarDataUrl} size={17} />
                  : 'A'}
              </div>
              <div className="message-main">
                <div className="message-meta"><strong>{message.role === 'assistant' ? configLabel(agentName, session?.sessionKind === 'subagent') : 'You'}</strong><span>{message.timestamp ? formatRelative(message.timestamp) : ''}</span>{message.role === 'assistant' && message.iterations !== undefined && <span>{message.iterations} {message.iterations === 1 ? 'step' : 'steps'}</span>}</div>
                {message.content && <MessageBody content={message.content} />}
                {message.interrupted && <div className="message-interrupted" role="status">This reply did not finish. Your message is preserved; you can try again.</div>}
                {message.role === 'user' && message.tokensIn !== undefined && <div className="message-usage" title={message.tokenCountsEstimated ? 'Approximate count based on message length.' : 'Input tokens'}>
                  <span><Sparkles size={12} />{message.tokenCountsEstimated ? '~' : ''}{message.tokensIn} input tokens</span>
                </div>}
                {message.role === 'assistant' && !message.streaming && !message.progressUpdate && <div className="message-usage" aria-label="Response usage">
                  <span><Clock3 size={12} />{formatChatElapsed(message.durationMs)}</span>
                  {message.tokensOut !== undefined && <span title={message.tokenCountsEstimated ? 'Approximate count based on response length.' : 'Provider-reported output token count'}><Sparkles size={12} />{message.tokenCountsEstimated ? '~' : ''}{message.tokensOut} output tokens</span>}
                  <span><Wrench size={12} />{message.toolCalls?.length ?? 0} tool {(message.toolCalls?.length ?? 0) === 1 ? 'call' : 'calls'}</span>
                </div>}
                {message.streaming && message.toolActivity?.length ? (
                  <details className="tool-activity">
                    <summary><Wrench size={14} />{message.toolActivity.length} tool {message.toolActivity.length === 1 ? 'action' : 'actions'}<ChevronDown size={14} /></summary>
                    <div className="tool-activity-list">{message.toolActivity.map((tool, index) => <div key={`${tool.name}-${index}`}><code>{tool.name}</code><span>{tool.status === 'running' ? 'Running now' : 'Completed'}</span></div>)}</div>
                  </details>
                ) : null}
                {message.streaming && message.todoActivity?.length ? <TodoActivityBubble items={message.todoActivity} /> : null}
                {message.streaming && (() => {
                  const activity = isAgentActivity(message.activityState) ? message.activityState : message.activeTool ? getToolActivity(message.activeTool).activity : 'thinking';
                  const tool = message.activeTool ? getToolActivity(message.activeTool) : undefined;
                  return <ReasoningDisplay activity={activity} toolLabel={tool ? `Executing · ${tool.label}` : undefined} />;
                })()}
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
          {sending && !messages.some(message => message.role === 'assistant' && message.streaming) && <div className="thinking-row"><ActivityOrb label="Agent is connecting" loading /><span>Agent is connecting</span></div>}
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
  tabs: Array<{ index: number; url: string; title: string; active: boolean }>;
}

interface BrowserBookmark {
  title: string;
  url: string;
}

const DEFAULT_BROWSER_HOMEPAGE = 'https://symbiote.artifactvirtual.com';
const BROWSER_BOOKMARKS_KEY = 'symbiote-browser-bookmarks-v1';

function initialBrowserBookmarks(): BrowserBookmark[] {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(BROWSER_BOOKMARKS_KEY) ?? '[]');
    if (!Array.isArray(stored)) return [];
    return stored.filter((item): item is BrowserBookmark =>
      Boolean(item)
      && typeof item === 'object'
      && typeof item.title === 'string'
      && typeof item.url === 'string'
      && /^https?:\/\//i.test(item.url),
    );
  } catch {
    return [];
  }
}

function BrowserView() {
  const [frame, setFrame] = useState<BrowserFrame | null>(null);
  const [address, setAddress] = useState('');
  const [bookmarks, setBookmarks] = useState<BrowserBookmark[]>(initialBrowserBookmarks);
  const [inputText, setInputText] = useState('');
  const [key, setKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const imageRef = useRef<HTMLImageElement>(null);
  const currentFrame = useRef<BrowserFrame | null>(null);
  const actionInFlight = useRef(false);
  const snapshotInFlight = useRef(false);
  const loadingRef = useRef(loading);
  const addressDirtyRef = useRef(false);
  currentFrame.current = frame;
  loadingRef.current = loading;

  const capture = useCallback(async () => {
    if (snapshotInFlight.current) return;
    snapshotInFlight.current = true;
    try {
      const next = await api<BrowserFrame>('/api/browser/snapshot');
      setFrame(next);
      if (!addressDirtyRef.current) setAddress(next.url === 'about:blank' ? '' : next.url);
      setError('');
    } finally {
      snapshotInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(BROWSER_BOOKMARKS_KEY, JSON.stringify(bookmarks));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Browser bookmarks could not be saved.');
    }
  }, [bookmarks]);

  useEffect(() => {
    void capture().catch(failure => setError(failure instanceof Error ? failure.message : 'Browser is not available.'));
    const timer = window.setInterval(() => {
      if (!loadingRef.current) void capture().catch(failure => setError(failure instanceof Error ? failure.message : 'Could not refresh browser.'));
    }, 5000);
    return () => window.clearInterval(timer);
  }, [capture]);

  const navigateTo = async (event?: FormEvent, requestedAddress?: string) => {
    event?.preventDefault();
    const targetAddress = (requestedAddress ?? address).trim();
    if (!targetAddress || loading || actionInFlight.current) return;
    actionInFlight.current = true;
    setLoading(true);
    setError('');
    addressDirtyRef.current = false;
    try {
      const next = await api<Pick<BrowserFrame, 'url' | 'title'>>('/api/browser/navigate', {
        method: 'POST',
        body: JSON.stringify({ url: targetAddress }),
      });
      if (!addressDirtyRef.current) setAddress(next.url);
      await capture();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Browser navigation failed.');
    } finally {
      actionInFlight.current = false;
      setLoading(false);
    }
  };

  const act = async (action: string, values: Record<string, unknown>) => {
    if (loading || actionInFlight.current) return;
    actionInFlight.current = true;
    setLoading(true);
    setError('');
    try {
      const next = await api<BrowserFrame>('/api/browser/action', {
        method: 'POST',
        body: JSON.stringify({ action, ...values }),
      });
      setFrame(next);
      if (action.startsWith('tab_')) {
        setAddress(next.url === 'about:blank' ? '' : next.url);
        addressDirtyRef.current = false;
      } else if (!addressDirtyRef.current) {
        setAddress(next.url);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Browser action failed.');
    } finally {
      actionInFlight.current = false;
      setLoading(false);
    }
  };

  const saveCurrentBookmark = () => {
    if (!frame?.url || !/^https?:\/\//i.test(frame.url)) return;
    setBookmarks(current => current.some(bookmark => bookmark.url === frame.url)
      ? current.filter(bookmark => bookmark.url !== frame.url)
      : [...current, { title: frame.title || new URL(frame.url).hostname, url: frame.url }]);
  };

  const isCurrentBookmarked = bookmarks.some(bookmark => bookmark.url === frame?.url);

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
          <input id="browser-address" value={address} onChange={event => { addressDirtyRef.current = true; setAddress(event.target.value); }} placeholder="Enter a website address" autoComplete="url" spellCheck={false} />
          <button className="icon-button" type="submit" disabled={loading || !address.trim()} aria-label="Go to address" title="Go">{loading ? <BrowserLoading label="Navigating" compact /> : <ArrowRight size={16} />}</button>
        </form>
        <div className="browser-tabs" role="tablist" aria-label="Browser tabs">
          {(frame?.tabs ?? []).map(tab => (
            <div className="browser-tab-shell" key={tab.index}>
              <button
                className={`browser-tab${tab.active ? ' browser-tab-active' : ''}`}
                type="button"
                role="tab"
                aria-selected={tab.active}
                title={tab.title || tab.url}
                onClick={() => void act('tab_switch', { index: tab.index })}
              >
                <span>{tab.title || (tab.url === 'about:blank' ? 'New tab' : tab.url)}</span>
              </button>
              {(frame?.tabs.length ?? 0) > 1 && <button
                className="browser-tab-close"
                type="button"
                aria-label={`Close ${tab.title || 'browser'} tab`}
                title="Close tab"
                disabled={loading}
                onClick={() => void (tab.active ? act('tab_close', {}) : act('tab_switch', { index: tab.index }).then(() => act('tab_close', {})))}
              ><X size={12} /></button>}
            </div>
          ))}
          <button className="browser-new-tab" type="button" aria-label="New tab" title="New tab" disabled={loading} onClick={() => void act('tab_open', {})}><Plus size={15} /></button>
        </div>
        <div className="browser-bookmarks" aria-label="Bookmarks">
          <div className="browser-bookmark-list">
            {bookmarks.map(bookmark => (
              <button className="browser-bookmark" type="button" key={bookmark.url} title={bookmark.url} onClick={() => void navigateTo(undefined, bookmark.url)}>
                <Bookmark size={12} /><span>{bookmark.title}</span>
              </button>
            ))}
            {!bookmarks.length && <span className="browser-bookmarks-empty">Bookmarks you add will appear here</span>}
          </div>
          <button
            className={`browser-bookmark-action${isCurrentBookmarked ? ' browser-bookmark-saved' : ''}`}
            type="button"
            aria-pressed={isCurrentBookmarked}
            disabled={!frame?.url || !/^https?:\/\//i.test(frame.url)}
            onClick={saveCurrentBookmark}
            title={isCurrentBookmarked ? 'Remove bookmark' : 'Bookmark current page'}
          ><Bookmark size={14} />{isCurrentBookmarked ? 'Saved' : 'Bookmark'}</button>
        </div>
        <div className="browser-titlebar"><span className="browser-status-dot" /><strong>{frame?.title || 'Browser session'}</strong><span>{frame?.viewport ? `${frame.viewport.width} × ${frame.viewport.height}` : ''}</span><button className="icon-button small" onClick={() => void capture().catch(failure => setError(failure instanceof Error ? failure.message : 'Could not capture the page.'))} aria-label="Refresh screenshot" title="Refresh"><RefreshCw size={14} /></button></div>
        {error && <div className="browser-error" role="alert"><span>{error}</span><button className="button button-secondary" onClick={() => void navigateTo(undefined, DEFAULT_BROWSER_HOMEPAGE)}>Open homepage</button></div>}
        <div className="browser-viewport">
          {frame
            ? <img ref={imageRef} src={frame.image} alt={`Interactive browser page: ${frame.title}`} draggable={false}
              onClick={event => { const point = viewportPoint(event); if (point) void act('click', point); }}
              />
            : <div className="browser-empty">{loading ? <BrowserLoading label="Loading page" /> : <Globe size={25} />}<span>{loading ? 'Loading page…' : 'Open a website to begin browsing.'}</span><button className="button button-secondary" onClick={() => void navigateTo(undefined, DEFAULT_BROWSER_HOMEPAGE)}>Open Symbiote homepage</button></div>}
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

function configLabel(name?: string, subagent = false): string {
  return subagent ? 'Subagent' : name || 'Symbiote';
}

function OperationsView(props: {
  status: GatewayStatus | null;
  connected: boolean;
  channels: GatewayStatus['channels'];
  logLines: string;
  query: string;
  onQuery: (query: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  lastUpdated: number | null;
  refreshIntervalMs: number;
  onRefresh: () => void;
  onRestartChannel: (channelType: string) => Promise<void>;
  onClearIncidents: () => Promise<void>;
}) {
  const { status, connected, channels, logLines, query, onQuery, searchRef, lastUpdated, refreshIntervalMs, onRefresh, onRestartChannel, onClearIncidents } = props;
  const [copyStatus, setCopyStatus] = useState('');
  const [showIncidents, setShowIncidents] = useState(false);
  const filteredLogLines = query.trim()
    ? logLines.split(/\r?\n/).filter(line => line.toLowerCase().includes(query.trim().toLowerCase())).join('\n')
    : logLines;
  const host = status?.metrics?.system?.host;
  const warmestSensor = host?.temperature.sensors.reduce((warmest, sensor) => !warmest || sensor.celsius > warmest.celsius ? sensor : warmest, undefined as HostResourceSnapshot['temperature']['sensors'][number] | undefined);
  const healthTelemetry = status?.healthTelemetry;
  const hardwareMeasures = [
    host?.cpuPercent == null ? null : 100 - host.cpuPercent,
    host?.memory.usedPercent == null ? null : 100 - host.memory.usedPercent,
    host?.gpu.loadPercent == null ? null : 100 - host.gpu.loadPercent,
    warmestSensor ? Math.max(0, Math.min(100, ((95 - warmestSensor.celsius) / 50) * 100)) : null,
  ].filter((value): value is number => value !== null && Number.isFinite(value));
  const hardwareScore = hardwareMeasures.length
    ? Math.round(hardwareMeasures.reduce((total, value) => total + value, 0) / hardwareMeasures.length)
    : null;
  const telemetryDuration = (ms: number) => {
    const hours = Math.floor(ms / 3_600_000);
    const minutes = Math.floor((ms % 3_600_000) / 60_000);
    return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
  };
  const telemetry = [
    {
      label: 'Gateway health',
      icon: Server,
      value: !connected ? 'OFF' : healthTelemetry ? `${healthTelemetry.gateway.score}%` : '—',
      detail: !connected
        ? 'Gateway not reachable; last received values are shown'
        : healthTelemetry
        ? `${telemetryDuration(healthTelemetry.gateway.uptimeMs)} online · ${healthTelemetry.gateway.issueCount} incidents in 24h`
        : 'Collecting gateway uptime and incident history',
      percent: healthTelemetry?.gateway.score ?? null,
    },
    {
      label: 'Provider health',
      icon: Workflow,
      value: healthTelemetry?.providers.score == null ? '—' : `${healthTelemetry.providers.score}%`,
      detail: healthTelemetry
        ? `${healthTelemetry.providers.calls} calls · ${healthTelemetry.providers.failures} failed in 24h`
        : 'Collecting provider call results',
      percent: healthTelemetry?.providers.score ?? null,
    },
    {
      label: 'Hardware headroom',
      icon: Cpu,
      value: hardwareScore === null ? '—' : `${hardwareScore}%`,
      detail: hardwareScore === null
        ? 'Awaiting host resource sample'
        : `${hardwareMeasures.length} live signals · CPU, memory, GPU and temperature`,
      percent: hardwareScore,
    },
  ];
  const recentEvents = (healthTelemetry?.recentEvents ?? []).filter(event =>
    event.type === 'gateway.issue'
      || event.type === 'gateway.outage'
      || event.type === 'provider.call' && !event.succeeded,
  ).slice(0, 8);
  const incidentCount = (healthTelemetry?.gateway.issueCount ?? 0) + (healthTelemetry?.providers.failures ?? 0);
  const logRefreshIntervalMs = Math.max(1000, refreshIntervalMs);
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
      <PageHeading eyebrow="LIVE SYSTEM TELEMETRY" title="Health" detail="24-hour gateway availability, provider call reliability, and live hardware resource headroom." action={<button className="button button-secondary" onClick={onRefresh}><RefreshCw size={15} />Refresh now</button>} />
      <div className="operation-summary">
        <div className="operation-summary-mark"><Gauge size={19} /></div>
        <div className="operation-summary-copy"><strong>{connected ? 'Gateway is responding' : 'Reconnecting to gateway'}</strong><span>{connected && status ? `Process ${status.pid ?? '—'} · Running for ${status.uptimeHuman ?? '—'} · ${status.activeTurns ?? 0} active turns` : 'The gateway connection will be retried automatically.'}</span></div>
        <span className={`status-tag${connected ? ' status-tag-live' : ' status-tag-idle'}`}><span />{connected ? 'Operational' : 'Retrying'}</span>
      </div>
      <section className="health-telemetry" aria-label="Live system telemetry">
        {telemetry.map(({ label, icon: Icon, value, detail, percent }) => {
          const boundedPercent = percent === null ? null : Math.max(0, Math.min(100, percent));
          const dialStyle = boundedPercent === null ? undefined : {
            background: `conic-gradient(var(--appearance-primary) ${boundedPercent * 3.6}deg, var(--line) 0deg)`,
          };
          return <article className="health-telemetry-card" key={label}>
            <div className="health-telemetry-heading"><span><Icon size={14} />{label}</span><small>{detail}</small></div>
            <div className="health-telemetry-reading">
              <div className={`health-telemetry-dial${boundedPercent === null ? ' health-telemetry-dial-static' : ''}`} style={dialStyle} aria-label={`${label}: ${value}`}>
                <span>{value}</span>
              </div>
              {boundedPercent !== null && <div className="health-telemetry-track"><span style={{ width: `${boundedPercent}%` }} /></div>}
            </div>
          </article>;
        })}
      </section>
      <div className="health-score-note">Gateway score combines measured availability with incident rate; provider score is successful calls divided by calls; hardware score is average resource headroom across available host sensors.</div>
      <div className="operation-columns">
        <section className="surface-card operation-panel">
          <div className="section-heading"><div><div className="eyebrow">CHANNEL ADAPTERS</div><h2>Connections</h2></div><span className="subtle-label">{channels.length} TOTAL</span></div>
          {channels.length ? <div className="connection-list">{channels.map(channel => <ChannelTile key={channel.id} channel={channel} qr={status?.whatsappQr} onRestart={type => void onRestartChannel(type)} />)}</div> : <EmptyState icon={Network} title="No active connections" detail="The gateway has not registered any channel adapters." />}
        </section>
      </div>
      <section className="surface-card health-events-panel" id="health-incidents">
        <header className="health-events-heading">
          <button className="health-events-toggle" type="button" onClick={() => setShowIncidents(open => !open)} aria-expanded={showIncidents}>
            <ChevronDown size={15} className={showIncidents ? 'health-events-chevron-open' : ''} />
            <span><strong>Incidents & failures</strong><small>{incidentCount} in the last 24 hours</small></span>
          </button>
          {incidentCount > 0 && <button className="text-button" type="button" onClick={() => void onClearIncidents()}>Clear</button>}
        </header>
        {showIncidents && (recentEvents.length
          ? <div className="health-event-list">{recentEvents.map((event, index) => {
            const isProvider = event.type === 'provider.call';
            const title = event.type === 'gateway.outage'
              ? 'Gateway recovered after an unclean stop'
              : event.type === 'gateway.issue'
                ? `Gateway issue · ${event.subsystem ?? 'runtime'}`
                : `Provider call failed · ${event.provider ?? 'unknown provider'}`;
            const detail = event.message || (isProvider ? 'Provider request failed.' : 'Gateway incident recorded.');
            return <article className="health-event-row" key={`${event.timestamp}-${event.type}-${index}`}>
              <span className={`health-event-mark${isProvider ? ' health-event-provider' : ''}`}><CircleAlert size={14} /></span>
              <span className="health-event-copy"><strong>{title}</strong><small>{detail}</small></span>
              <time dateTime={new Date(event.timestamp).toISOString()}>{new Date(event.timestamp).toLocaleString()}</time>
            </article>;
          })}</div>
          : <div className="inline-empty"><span className="empty-icon"><CircleCheck size={17} /></span><div><strong>No recent incidents or failures</strong></div></div>)}
      </section>
      <section className="surface-card log-panel">
        <div className="section-heading log-heading"><div><div className="eyebrow">SERVICE OUTPUT · LOCAL MACHINE</div><h2>Recent log</h2></div><div className="log-actions"><span className="subtle-label">{lastUpdated ? `POLLING EVERY ${Math.round(logRefreshIntervalMs / 100) / 10}S` : 'AWAITING LOG'}</span><button className="button button-secondary log-action-button" onClick={() => void copyLog()} disabled={!filteredLogLines}>{copyStatus === 'Copied' ? <Check size={14} /> : <Copy size={14} />}{copyStatus || 'Copy'}</button><button className="button button-secondary log-action-button" onClick={downloadLog} disabled={!logLines}><Download size={14} />Save</button></div></div>
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

function SettingsView({ config, status, refreshIntervalMs, onRefreshIntervalChange }: {
  config: GatewayConfig | null;
  status: GatewayStatus | null;
  refreshIntervalMs: number;
  onRefreshIntervalChange: (value: number) => void;
}) {
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
        <div className="section-heading"><div><div className="eyebrow">LIVE TELEMETRY</div><h2>Refresh cadence</h2></div><span className="settings-source"><Activity size={14} />BROWSER SETTING</span></div>
        <p className="settings-access-copy">Controls how often Health and Workspace request gateway data. Updates are limited to the host sampler’s cadence to keep the dashboard responsive.</p>
        <label className="telemetry-refresh-control">
          <span><strong>Health & dashboard refresh</strong><output>{refreshIntervalMs} ms</output></span>
          <input
            className="appearance-range appearance-range-brightness"
            type="range"
            min={MIN_REFRESH_INTERVAL_MS}
            max={MAX_REFRESH_INTERVAL_MS}
            step={1000}
            value={refreshIntervalMs}
            aria-label="Health and dashboard refresh interval in milliseconds"
            onChange={event => onRefreshIntervalChange(Number(event.target.value))}
          />
          <small>3–5 s · saved in this browser</small>
        </label>
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
          <button className="button button-secondary" type="button" disabled={tokenLoading} onClick={() => void showLanToken()}>{tokenLoading ? <ActivityOrb label="Loading token" compact loading /> : <ShieldCheck size={14} />}{tokenLoading ? 'Loading token' : 'Reveal LAN token'}</button>
        )}
        {tokenError && <p className="settings-token-error" role="alert">{tokenError}</p>}
        {window.symbioteDesktop && <div className="settings-firewall">
          <button className="button button-secondary" type="button" disabled={firewallLoading} onClick={() => void configureLanFirewall()}>
            {firewallLoading ? <ActivityOrb label="Checking firewall" compact loading /> : <ShieldCheck size={14} />}
            {firewallLoading ? 'Waiting for permission' : 'Configure Windows Firewall'}
          </button>
          {firewallStatus && <p className="settings-token-error" role="status">{firewallStatus}</p>}
        </div>}
      </section>
      <div className="notice notice-info"><ShieldCheck size={16} /><span>Runtime configuration secrets are never revealed here. Configuration changes remain in the local config file; Google Workspace authorization is managed separately in Integrations.</span></div>
    </div>
  );
}

function Setting({ label, value, wide }: { label: string; value?: string; wide?: boolean }) {
  return <div className={`setting-field${wide ? ' setting-wide' : ''}`}><span>{label}</span><strong>{value || 'Not reported'}</strong></div>;
}
