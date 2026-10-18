import {
  Activity, Bot, Brain, Cloud, Code, Compass, Cpu, Database, Eye, FolderOpen, Gauge, Globe, HardDrive,
  Leaf, LayoutDashboard, MessageSquare, Network, Search, Server, ShieldCheck, Sparkles, TerminalSquare,
  Users, Workflow, Wrench,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export const AGENT_ICON_CHOICES: Array<{ id: string; label: string; icon: LucideIcon }> = [
  { id: 'bot', label: 'Bot', icon: Bot },
  { id: 'brain', label: 'Brain', icon: Brain },
  { id: 'compass', label: 'Compass', icon: Compass },
  { id: 'leaf', label: 'Leaf', icon: Leaf },
  { id: 'sparkles', label: 'Sparkles', icon: Sparkles },
  { id: 'terminal', label: 'Terminal', icon: TerminalSquare },
  { id: 'globe', label: 'Globe', icon: Globe },
  { id: 'database', label: 'Database', icon: Database },
  { id: 'shield', label: 'Shield', icon: ShieldCheck },
  { id: 'wrench', label: 'Wrench', icon: Wrench },
  { id: 'network', label: 'Network', icon: Network },
  { id: 'cpu', label: 'Processor', icon: Cpu },
  { id: 'server', label: 'Server', icon: Server },
  { id: 'message', label: 'Message', icon: MessageSquare },
  { id: 'users', label: 'Team', icon: Users },
  { id: 'workflow', label: 'Workflow', icon: Workflow },
  { id: 'gauge', label: 'Gauge', icon: Gauge },
  { id: 'hard-drive', label: 'Storage', icon: HardDrive },
  { id: 'cloud', label: 'Cloud', icon: Cloud },
  { id: 'activity', label: 'Activity', icon: Activity },
  { id: 'folder', label: 'Folder', icon: FolderOpen },
  { id: 'layout', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'code', label: 'Code', icon: Code },
  { id: 'search', label: 'Search', icon: Search },
  { id: 'eye', label: 'Vision', icon: Eye },
];

const LEGACY_ICON_IDS: Record<string, string> = {
  '\u{1F916}': 'bot',
  '\u{1F9E0}': 'brain',
  '\u{1F9ED}': 'compass',
  '\u{1F33F}': 'leaf',
  '\u{2728}': 'sparkles',
};

export function normalizeAgentIconId(value?: string): string {
  const normalized = value ? LEGACY_ICON_IDS[value] ?? value : 'bot';
  return AGENT_ICON_CHOICES.some(choice => choice.id === normalized) ? normalized : 'bot';
}

export function AgentIcon({ id, size = 16, className }: { id?: string; size?: number; className?: string }) {
  const selectedId = normalizeAgentIconId(id);
  const Icon = AGENT_ICON_CHOICES.find(choice => choice.id === selectedId)?.icon ?? Bot;
  return <Icon size={size} className={className} aria-hidden="true" />;
}

export function AgentIconPicker({ id, value, onChange }: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const selectedId = normalizeAgentIconId(value);
  const selected = AGENT_ICON_CHOICES.find(choice => choice.id === selectedId) ?? AGENT_ICON_CHOICES[0];
  const SelectedIcon = selected.icon;
  return (
    <div className="agent-icon-picker">
      <span className="agent-icon-picker-preview"><SelectedIcon size={18} /><span>{selected.label}</span></span>
      <select id={id} value={selectedId} onChange={event => onChange(event.target.value)} aria-label="Agent avatar icon">
        {AGENT_ICON_CHOICES.map(choice => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
      </select>
    </div>
  );
}
