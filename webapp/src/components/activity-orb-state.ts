import type { OrbState } from 'thinking-orbs';

export type AgentActivity =
  | 'thinking'
  | 'reasoning'
  | 'responding'
  | 'reading'
  | 'writing'
  | 'editing'
  | 'executing'
  | 'searching'
  | 'browsing'
  | 'analyzing'
  | 'generating'
  | 'recalling'
  | 'staging'
  | 'spawning'
  | 'speaking'
  | 'listening'
  | 'reacting';

const ACTIVITY_STATES: Record<AgentActivity, OrbState> = {
  thinking: 'solving',
  reasoning: 'weaving',
  responding: 'composing',
  reading: 'searching',
  writing: 'composing',
  editing: 'shaping',
  executing: 'working',
  searching: 'searching',
  browsing: 'connecting',
  analyzing: 'solving',
  generating: 'composing',
  recalling: 'weaving',
  staging: 'connecting',
  spawning: 'connecting',
  speaking: 'listening',
  listening: 'listening',
  reacting: 'shaping',
};

const ACTIVITY_LABELS: Record<AgentActivity, string> = {
  thinking: 'Thinking…',
  reasoning: 'Reasoning…',
  responding: 'Writing response…',
  reading: 'Reading…',
  writing: 'Writing…',
  editing: 'Editing…',
  executing: 'Executing…',
  searching: 'Searching…',
  browsing: 'Browsing…',
  analyzing: 'Analyzing…',
  generating: 'Generating…',
  recalling: 'Recalling…',
  staging: 'Staging…',
  spawning: 'Spawning…',
  speaking: 'Speaking…',
  listening: 'Listening…',
  reacting: 'Reacting…',
};

interface ToolActivity {
  activity: AgentActivity;
  label: string;
}

const TOOL_ACTIVITIES: Record<string, ToolActivity> = {
  read: { activity: 'reading', label: 'Reading' },
  write: { activity: 'writing', label: 'Writing' },
  edit: { activity: 'editing', label: 'Editing' },
  exec: { activity: 'executing', label: 'Executing' },
  process_start: { activity: 'executing', label: 'Executing' },
  process_poll: { activity: 'executing', label: 'Executing' },
  process_kill: { activity: 'executing', label: 'Executing' },
  process_list: { activity: 'executing', label: 'Executing' },
  image: { activity: 'analyzing', label: 'Analyzing' },
  web_fetch: { activity: 'browsing', label: 'Browsing' },
  memory_search: { activity: 'searching', label: 'Searching' },
  comb_recall: { activity: 'recalling', label: 'Recalling' },
  comb_stage: { activity: 'staging', label: 'Staging' },
  tts: { activity: 'generating', label: 'Generating' },
  message: { activity: 'responding', label: 'Writing response' },
  typing: { activity: 'responding', label: 'Writing response' },
  presence: { activity: 'responding', label: 'Writing response' },
  delete_message: { activity: 'editing', label: 'Editing' },
  mark_read: { activity: 'reading', label: 'Reading' },
  spawn: { activity: 'spawning', label: 'Spawning' },
  subagent_status: { activity: 'searching', label: 'Searching' },
};

export function getActivityOrbState(activity: AgentActivity): OrbState {
  return ACTIVITY_STATES[activity];
}

export function getLoadingOrbState(): OrbState {
  return 'breathing';
}

export function getActivityLabel(activity: AgentActivity): string {
  return ACTIVITY_LABELS[activity];
}

export function getToolActivity(toolName: string): ToolActivity {
  return TOOL_ACTIVITIES[toolName] ?? { activity: 'executing', label: toolName.replaceAll('_', ' ') };
}

export function getActivityFromStatus(status?: string, toolName?: string): AgentActivity {
  if (toolName) return getToolActivity(toolName).activity;
  const normalized = status?.trim().toLowerCase() ?? '';
  if (normalized.includes('reason')) return 'reasoning';
  if (normalized.includes('writ') || normalized.includes('respond')) return 'responding';
  if (normalized.includes('execut')) return 'executing';
  if (normalized.includes('read')) return 'reading';
  if (normalized.includes('search')) return 'searching';
  if (normalized.includes('brows')) return 'browsing';
  if (normalized.includes('edit')) return 'editing';
  if (normalized.includes('think') || normalized.includes('start') || normalized.includes('wait')) return 'thinking';
  return 'thinking';
}

export function isAgentActivity(value: unknown): value is AgentActivity {
  return typeof value === 'string' && Object.hasOwn(ACTIVITY_STATES, value);
}
