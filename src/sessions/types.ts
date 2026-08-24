// Symbiote — Session types (enhanced with metadata, sub-agents)

import type { Message } from '../providers/types.js';

export interface SessionMetadata {
  label?: string;
  provider?: string;
  model?: string;
  messageCount: number;
  tokenUsage: { input: number; output: number };
  toolsUsed: Record<string, number>; // tool name → call count
  parentSessionId?: string;
  depth: number; // sub-agent nesting depth (0 = root)
}

export interface Session {
  id: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
  metadata: SessionMetadata;
}

export interface SessionSummary {
  id: string;
  label?: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  provider?: string;
  model?: string;
}

export interface SubAgentConfig {
  parentSessionId: string;
  task: string;
  provider?: string;
  model?: string;
  maxIterations?: number;
  depth: number;
}

export interface SubAgentHandle {
  sessionId: string;
  task: string;
  status: 'running' | 'completed' | 'failed' | 'killed';
  startedAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
}
