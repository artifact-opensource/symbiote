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
  thinking: 'Thinking',
  reasoning: 'Reasoning',
  responding: 'Responding',
  reading: 'Reading',
  writing: 'Writing',
  editing: 'Editing',
  executing: 'Executing',
  searching: 'Searching',
  browsing: 'Browsing',
  analyzing: 'Analyzing',
  generating: 'Generating',
  recalling: 'Recalling',
  staging: 'Staging memory',
  spawning: 'Starting sub-agent',
  speaking: 'Speaking',
  listening: 'Listening',
  reacting: 'Reacting',
};

interface ToolActivity {
  activity: AgentActivity;
  label: string;
}

const TOOL_ACTIVITIES: Record<string, ToolActivity> = {
  read: { activity: 'reading', label: 'Reading files' },
  write: { activity: 'writing', label: 'Writing files' },
  edit: { activity: 'editing', label: 'Editing files' },
  exec: { activity: 'executing', label: 'Running command' },
  process_start: { activity: 'executing', label: 'Launching process' },
  process_poll: { activity: 'executing', label: 'Checking process' },
  process_kill: { activity: 'executing', label: 'Stopping process' },
  process_list: { activity: 'executing', label: 'Listing processes' },
  image: { activity: 'analyzing', label: 'Analyzing image' },
  web_fetch: { activity: 'browsing', label: 'Browsing the web' },
  memory_search: { activity: 'searching', label: 'Searching memory' },
  comb_recall: { activity: 'recalling', label: 'Recalling memory' },
  comb_stage: { activity: 'staging', label: 'Staging memory' },
  tts: { activity: 'generating', label: 'Generating speech' },
  message: { activity: 'responding', label: 'Sending message' },
  typing: { activity: 'responding', label: 'Communicating' },
  presence: { activity: 'responding', label: 'Updating presence' },
  delete_message: { activity: 'editing', label: 'Cleaning up messages' },
  mark_read: { activity: 'reading', label: 'Reading messages' },
  spawn: { activity: 'spawning', label: 'Starting sub-agent' },
  subagent_status: { activity: 'searching', label: 'Checking sub-agent' },
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
