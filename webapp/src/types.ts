export type ViewId = 'workspace' | 'runs' | 'agents' | 'chat' | 'browser' | 'memory' | 'sessions' | 'games' | 'operations' | 'tools' | 'settings';

export interface MemoryGraphNode {
  id: string;
  label: string;
  excerpt: string;
  source: string;
  role: string;
  timestamp: number;
  sessionId?: string;
  side: 'documents' | 'sessions';
}

export interface MemoryGraphEdge {
  source: string;
  target: string;
  similarity: number;
}

export interface MemoryGraphData {
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
  namespace?: string;
  metadata?: Record<string, string>;
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
}

export interface SessionSummary {
  id: string;
  label?: string;
  messageCount: number;
  updatedAt: number;
  createdAt: number;
  parentSessionId?: string;
  sessionKind?: 'conversation' | 'subagent';
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp?: number;
  durationMs?: number;
  iterations?: number;
  toolCalls?: Array<{ name: string; input: Record<string, unknown>; result: string }>;
  streaming?: boolean;
  activeTools?: string[];
  thinking?: boolean;
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
  uptime?: number;
  uptimeHuman?: string;
  provider?: string;
  channels: ChannelStatus[];
  activeTurns?: number;
  sessions?: number;
  tools?: number;
  providerHealth?: Record<string, unknown> | unknown[];
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
