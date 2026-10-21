export type ViewId = 'workspace' | 'ide' | 'runs' | 'agents' | 'projects' | 'threads' | 'chat' | 'browser' | 'memory' | 'games' | 'integrations' | 'operations' | 'tools' | 'settings';

export interface MemoryGraphNode {
  id: string;
  label: string;
  excerpt: string;
  source: string;
  storage?: string;
  role: string;
  timestamp: number;
  sessionId?: string;
  namespace?: string;
  metadata?: Record<string, string>;
  side: 'documents' | 'sessions' | 'projects';
}

export interface MemoryGraphEdge {
  source: string;
  target: string;
  similarity: number;
}

export interface MemoryGraphData {
  storage?: string;
  stats: {
    documentCount: number;
    termCount: number;
    diskBytes: number;
    lastIndexed: number;
    sources: Record<string, number>;
  };
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
}

export interface MemoryDocument extends MemoryGraphNode {
  text: string;
}

export interface MemoryNodeContext {
  selected: {
    id: string;
    label: string;
    kind: 'system' | 'domain' | 'source' | 'document';
    side: string;
    source?: string;
    storage?: string;
    role?: string;
    timestamp?: number;
    sessionId?: string;
    namespace?: string;
    metadata?: Record<string, string>;
    excerpt?: string;
    text?: string;
    documentCount?: number;
  };
  similarity: {
    threshold: number;
    count: number;
    average: number;
    highest: number;
    neighbors: Array<{
      id: string;
      label: string;
      source: string;
      side: MemoryGraphNode['side'];
      role: string;
      similarity: number;
    }>;
  };
}

export interface WorkspaceRun {
  id: string;
  sessionId: string;
  name: string;
  prompt: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
  toolNames?: string[];
  activity?: string;
  activeTool?: string;
  operations?: Array<{ name: string; status: 'running' | 'done'; startedAt: number; completedAt?: number }>;
  activityLog?: Array<{ timestamp: number; kind: 'thinking' | 'reasoning' | 'writing' | 'tool' | 'todo'; label: string; toolName?: string; status?: 'running' | 'done' }>;
  archivedAt?: number;
}

export interface WorkspaceAgent {
  sessionId: string;
  task: string;
  status: 'running' | 'completed' | 'failed' | 'killed';
  startedAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
  parentSessionId?: string;
  projectId?: string;
  agentId?: string;
  activity?: string;
  activeTool?: string;
  operations?: Array<{ name: string; status: 'running' | 'done'; startedAt: number; completedAt?: number }>;
  activityLog?: Array<{ timestamp: number; kind: 'thinking' | 'reasoning' | 'writing' | 'tool' | 'todo'; label: string; toolName?: string; status?: 'running' | 'done' }>;
}

export interface SessionSummary {
  id: string;
  label?: string;
  messageCount: number;
  updatedAt: number;
  createdAt: number;
  parentSessionId?: string;
  sessionKind?: 'conversation' | 'subagent';
  projectId?: string;
  agentId?: string;
}

export interface WorkspaceProject {
  id: string;
  name: string;
  workspace: string;
  scope?: string;
  createdAt: number;
  archivedAt?: number;
}

export interface ProjectTask {
  id: string;
  title: string;
  description: string;
  assignedAgentId?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  createdAt: number;
  updatedAt: number;
}

export interface WorkspaceFile {
  path: string;
  type: 'file' | 'directory';
  size: number;
  modifiedAt: number;
}

export interface ThreadUserHelpRequest {
  id: string;
  threadId: string;
  postId: string;
  title: string;
  body: string;
  createdAt: number;
}

export interface AgentProfile {
  id: string;
  projectId: string;
  name: string;
  emoji: string;
  instructions: string;
  workspace: string;
  createdAt: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp?: number;
  durationMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  tokenCountsEstimated?: boolean;
  iterations?: number;
  toolCalls?: Array<{ name: string; input: Record<string, unknown>; result: string }>;
  streaming?: boolean;
  activeTools?: string[];
  activeTool?: string;
  toolActivity?: Array<{ name: string; status: 'running' | 'done' }>;
  todoActivity?: Array<{ id: string; title: string; status: 'pending' | 'in_progress' | 'blocked' | 'completed' }>;
  thinking?: boolean;
  activityState?: string;
  interrupted?: boolean;
  progressUpdate?: boolean;
}

export interface ChannelStatus {
  id: string;
  channelType: string;
  status: string;
  health?: { state?: string; lastError?: string };
}

export interface HostResourceSnapshot {
  sampledAt: number;
  cpuPercent: number | null;
  cpuLogicalCores: number;
  cpuCorePercents?: Array<number | null>;
  gpu: {
    state: 'detecting' | 'available' | 'unavailable';
    devices: Array<{ name: string }>;
    loadPercent: number | null;
    dedicatedMemoryUsedBytes: number | null;
    dedicatedMemoryTotalBytes: number | null;
    sharedMemoryUsedBytes: number | null;
    source: string;
    unavailableReason?: string;
  };
  memory: { totalBytes: number; freeBytes: number; usedPercent: number };
  network: { receiveBytesPerSecond: number | null; transmitBytesPerSecond: number | null; source: string };
  disk: { readBytesPerSecond: number | null; writeBytesPerSecond: number | null; source: string };
  temperature: {
    sensors: Array<{ name: string; celsius: number; source: string }>;
    source: string;
    unavailableReason?: string;
  };
  warnings: string[];
}

export interface GatewayStatus {
  version?: string;
  sampledAt?: number;
  update?: {
    state: 'unknown' | 'current' | 'available' | 'error';
    currentVersion: string;
    latestVersion?: string;
    releaseUrl?: string;
    publishedAt?: string;
    checkedAt?: number;
    error?: string;
    download?: {
      state: 'idle' | 'downloading' | 'ready' | 'error';
      version?: string;
      filename?: string;
      sha256?: string;
      error?: string;
    };
  };
  uptime?: number;
  uptimeHuman?: string;
  provider?: string;
  channels: ChannelStatus[];
  whatsappQr?: { value: string; updatedAt: number };
  activeTurns?: number;
  sessions?: number;
  tools?: number;
  providerHealth?: Record<string, unknown> | unknown[];
  healthTelemetry?: {
    generatedAt: number;
    windowMs: number;
    gateway: {
      score: number;
      trackedMs: number;
      uptimeMs: number;
      downtimeMs: number;
      issueCount: number;
      lastIncidentAt?: number;
    };
    providers: {
      score: number | null;
      calls: number;
      failures: number;
      byProvider: Record<string, { calls: number; failures: number }>;
    };
    recentEvents: Array<{
      timestamp: number;
      type: string;
      subsystem?: string;
      provider?: string;
      succeeded?: boolean;
      latencyMs?: number;
      message?: string;
      outageStartedAt?: number;
    }>;
  };
  metrics?: {
    turnCount?: number;
    totalTurns?: number;
    turns?: number;
    system?: { host?: HostResourceSnapshot };
  };
  memory?: { rss?: number; heap?: number };
  pid?: number;
}

export interface GatewayConfig {
  name?: string;
  agentName?: string;
  agentEmoji?: string;
  agentAvatarDataUrl?: string;
  ownerName?: string;
  soulContent?: string;
  agentsContent?: string;
  agentInstructions?: string;
  version?: string;
  workspace?: string;
  provider?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  configuredProviders?: string[];
  gateway?: {
    webHost: string;
    webPort: number;
    apiHost: string;
    apiPort: number;
    apiEnabled: boolean;
  };
}

export interface ToolSummary {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}
