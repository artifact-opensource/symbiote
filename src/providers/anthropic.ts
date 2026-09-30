// Symbiote — Anthropic Messages API streaming provider (raw HTTP, no libraries)

import type { Message, ToolDef, ProviderConfig, StreamEvent, Provider, ContentBlock } from './types.js';
import { fetchWithRetry } from './retry.js';

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const API_VERSION = '2023-06-01';

function convertMessages(messages: Message[]): { system?: string; messages: unknown[] } {
  let system: string | undefined;
  const converted: unknown[] = [];

  // Build set of all tool_call IDs from assistant messages for orphan detection
  const allToolCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) allToolCallIds.add(tc.id);
    }
    if (msg.role === 'assistant' && typeof msg.content !== 'string') {
      for (const b of msg.content as ContentBlock[]) {
        if (b.type === 'tool_use' && b.id) allToolCallIds.add(b.id);
      }
    }
  }

  for (const msg of messages) {
    if (msg.role === 'system') {
      system = typeof msg.content === 'string' ? msg.content : msg.content.map(b => b.text ?? '').join('');
      continue;
    }

    if (msg.role === 'tool') {
      // Skip orphaned tool results
      if (msg.tool_call_id && !allToolCallIds.has(msg.tool_call_id)) {
        console.warn(`[anthropic] Skipping orphaned tool result: ${msg.tool_call_id}`);
        continue;
      }
      // Anthropic expects tool results as user messages with tool_result content blocks
      converted.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: msg.tool_call_id,
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
          ...(msg.name === '__error' ? { is_error: true } : {}),
        }],
      });
      continue;
    }

    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      // Assistant message with tool calls → content blocks
      const content: unknown[] = [];
      if (typeof msg.content === 'string' && msg.content) {
        content.push({ type: 'text', text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (b.type === 'text' && b.text) content.push({ type: 'text', text: b.text });
        }
      }
      for (const tc of msg.tool_calls) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
      }
      converted.push({ role: 'assistant', content });
      continue;
    }

    // Standard user/assistant
    if (typeof msg.content === 'string') {
      converted.push({ role: msg.role, content: msg.content });
    } else {
      const blocks: unknown[] = [];
      for (const b of msg.content as ContentBlock[]) {
        if (b.type === 'text') blocks.push({ type: 'text', text: b.text });
        else if (b.type === 'image' && b.source) {
          blocks.push({ type: 'image', source: b.source });
        } else if (b.type === 'tool_use') {
          blocks.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
        } else if (b.type === 'tool_result') {
          blocks.push({ type: 'tool_result', tool_use_id: b.tool_use_id, content: b.content });
        }
      }
      converted.push({ role: msg.role, content: blocks });
    }
  }

  return { system, messages: converted };
}

function convertTools(tools: ToolDef[]): unknown[] {
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

async function* streamAnthropic(
  messages: Message[],
  tools: ToolDef[],
  config: ProviderConfig,
): AsyncIterable<StreamEvent> {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const { system, messages: converted } = convertMessages(messages);

  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: config.maxTokens ?? 8192,
    stream: true,
    messages: converted,
  };
  if (system || config.systemPrompt) {
    body.system = config.systemPrompt ?? system;
  }
  if (config.temperature !== undefined) body.temperature = config.temperature;
  if (tools.length > 0) body.tools = convertTools(tools);

  const res = await fetchWithRetry(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey ?? '',
      'anthropic-version': API_VERSION,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(((config as unknown as Record<string, unknown>).timeoutMs as number) ?? 30_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${text}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';
  // Track content block index → tool ID from start events
  const blockIdMap = new Map<number, string>();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    let eventType = '';
    for (const line of lines) {
      if (line.startsWith('event: ')) {
        eventType = line.slice(7).trim();
        continue;
      }
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') return;

      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(data); } catch { continue; }

      switch (eventType) {
        case 'content_block_start': {
          const idx = parsed.index as number;
          const block = parsed.content_block as Record<string, unknown> | undefined;
          if (block?.type === 'tool_use') {
            const id = block.id as string;
            blockIdMap.set(idx, id);
            yield { type: 'tool_use_start', id, name: block.name as string };
          }
          break;
        }
        case 'content_block_delta': {
          const delta = parsed.delta as Record<string, unknown> | undefined;
          const idx = parsed.index as number;
          if (delta?.type === 'text_delta') {
            yield { type: 'text_delta', text: delta.text as string };
          } else if (delta?.type === 'input_json_delta') {
            const id = blockIdMap.get(idx) ?? `block_${idx}`;
            yield { type: 'tool_use_delta', id, input: delta.partial_json as string };
          } else if (delta?.type === 'thinking_delta') {
            yield { type: 'thinking_delta', text: delta.thinking as string };
          }
          break;
        }
        case 'content_block_stop': {
          const idx = parsed.index as number | undefined;
          if (idx !== undefined) {
            const id = blockIdMap.get(idx) ?? `block_${idx}`;
            yield { type: 'tool_use_end', id };
          }
          break;
        }
        case 'message_delta': {
          const delta = parsed.delta as Record<string, unknown> | undefined;
          const usage = parsed.usage as Record<string, unknown> | undefined;
          if (usage) {
            yield {
              type: 'usage',
              usage: {
                inputTokens: (usage.input_tokens as number) ?? 0,
                outputTokens: (usage.output_tokens as number) ?? 0,
              },
            };
          }
          if (delta?.stop_reason) {
            yield { type: 'done', stopReason: delta.stop_reason as string };
          }
          break;
        }
        case 'message_start': {
          const msg = parsed.message as Record<string, unknown> | undefined;
          const usage = msg?.usage as Record<string, unknown> | undefined;
          if (usage) {
            yield {
              type: 'usage',
              usage: {
                inputTokens: (usage.input_tokens as number) ?? 0,
                outputTokens: (usage.output_tokens as number) ?? 0,
                cacheReadTokens: (usage.cache_read_input_tokens as number) ?? 0,
                cacheWriteTokens: (usage.cache_creation_input_tokens as number) ?? 0,
              },
            };
          }
          break;
        }
      }
      eventType = '';
    }
  }
}

export const anthropicProvider: Provider = {
  name: 'anthropic',
  stream: streamAnthropic,
};
