export type ViewId = 'overview' | 'chat' | 'sessions' | 'operations' | 'tools' | 'settings';

export interface SessionSummary {
  id: string;
  label?: string;
  messageCount: number;
  updatedAt: number;
  createdAt: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp?: number;
  durationMs?: number;
  iterations?: number;
  toolCalls?: Array<{ name: string; input: Record<string, unknown>; result: string }>;
}

export interface ChannelStatus {
  id: string;
  channelType: string;
  status: string;
  health?: { state?: string; lastError?: string };
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
  metrics?: Record<string, number | undefined>;
  memory?: { rss?: number; heap?: number };
  pid?: number;
}

export interface GatewayConfig {
  name?: string;
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
