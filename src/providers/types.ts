// Symbiote Provider Types — the universal language between providers and the agent runner

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentBlock[];
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ContentBlock {
  type: 'text' | 'image' | 'tool_use' | 'tool_result';
  text?: string;
  // tool_use
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  // tool_result
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
  // image
  source?: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string };
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  extra?: Record<string, unknown>; // Provider-specific metadata (e.g. Gemini thought_signature)
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string; extra?: Record<string, unknown> }
  | { type: 'tool_use_delta'; id: string; input: string }
  | { type: 'tool_use_end'; id: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'usage'; usage: Usage }
  | { type: 'done'; stopReason: string };

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
}

export interface Provider {
  name: string;
  stream(
    messages: Message[],
    tools: ToolDef[],
    config: ProviderConfig,
  ): AsyncIterable<StreamEvent>;
}
