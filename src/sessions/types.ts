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
  archivedAt?: number;
  sessionKind?: 'conversation' | 'subagent';
  webRuns?: Array<{
    id: string;
    sessionId?: string;
    name: string;
    prompt: string;
    status: 'running' | 'completed' | 'failed' | 'cancelled';
    startedAt: number;
    completedAt?: number;
    result?: string;
    error?: string;
    toolNames?: string[];
  }>;
  webRun?: {
    id: string;
    name: string;
    prompt: string;
    status: 'running' | 'completed' | 'failed' | 'cancelled';
    startedAt: number;
    completedAt?: number;
    result?: string;
    error?: string;
    toolNames?: string[];
  };
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
  parentSessionId?: string;
  sessionKind?: 'conversation' | 'subagent';
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
