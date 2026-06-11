// Symbiote — OpenRouter Provider (OpenAI-compatible)
// Ported from Sirius B (Victus) — adapted for AVA's Symbiote

import type { Message, ToolDef, ProviderConfig, StreamEvent, Provider } from './types.js';
import { fetchWithRetry } from './retry.js';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

function convertMessages(messages: Message[]): unknown[] {
  const out: unknown[] = [];
  let pendingToolCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'system') {
      pendingToolCallIds.clear();
      out.push({ role: 'system', content: typeof msg.content === 'string' ? msg.content : msg.content.map(b => b.text ?? '').join('') });
      continue;
    }
    if (msg.role === 'tool') {
      if (!msg.tool_call_id || !pendingToolCallIds.has(msg.tool_call_id)) {
        console.warn(`[openrouter] Skipping non-contiguous or orphaned tool result: ${msg.tool_call_id ?? 'missing-id'}`);
        continue;
      }
      pendingToolCallIds.delete(msg.tool_call_id);
      out.push({ role: 'tool', tool_call_id: msg.tool_call_id, content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) });
      continue;
    }
    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      const content = typeof msg.content === 'string' && msg.content.trim() ? msg.content : '';
      const validToolCalls = msg.tool_calls.filter(tc => tc.name && /^[a-zA-Z0-9_.\-]+$/.test(tc.name));
      pendingToolCallIds = new Set(validToolCalls.map(tc => tc.id));
      out.push({
        role: 'assistant',
        content,
        tool_calls: validToolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.input) },
        })),
      });
      continue;
    }
    pendingToolCallIds.clear();
    out.push({ role: msg.role, content: typeof msg.content === 'string' ? msg.content : msg.content.map(b => b.text ?? '').join('') });
  }
  return out;
}

function convertTools(tools: ToolDef[]): unknown[] {
  return tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

async function* streamOpenRouter(
  messages: Message[],
  tools: ToolDef[],
  config: ProviderConfig,
): AsyncIterable<StreamEvent> {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;

  const body: Record<string, unknown> = {
    model: config.model,
    stream: true,
    messages: convertMessages(messages),
  };
  if (config.maxTokens) body.max_tokens = config.maxTokens;
  if (config.temperature !== undefined) body.temperature = config.temperature;
  if (tools.length > 0) body.tools = convertTools(tools);

  const endpoint = `${baseUrl}/chat/completions`;
  const res = await fetchWithRetry(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey ?? ''}`,
      'X-Title': 'Symbiote',
      'HTTP-Referer': 'https://github.com/Artifact-Virtual',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000), // 5 minutes
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter API error ${res.status}: ${text}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';
  const activeTools = new Map<number, string>();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) {
        continue;
      }
      const data = line.slice(6).trim();
      if (data === '[DONE]') {
        yield { type: 'done', stopReason: 'end_turn' };
        return;
      }

      let parsed: any;
      try { parsed = JSON.parse(data); } catch { continue; }

      // Handle usage (if present in chunks)
      if (parsed.usage) {
        yield {
          type: 'usage',
          usage: {
            inputTokens: parsed.usage.prompt_tokens ?? 0,
            outputTokens: parsed.usage.completion_tokens ?? 0,
          },
        };
      }

      const choices = parsed.choices as any[];
      if (!choices?.length) continue;

      const choice = choices[0];
      const delta = choice.delta;

      if (delta?.content) {
        yield { type: 'text_delta', text: delta.content };
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          const fn = tc.function;

          if (tc.id) {
            activeTools.set(idx, tc.id);
            yield { type: 'tool_use_start', id: tc.id, name: fn?.name ?? '' };
          }

          if (fn?.arguments) {
            const id = activeTools.get(idx);
            if (id) yield { type: 'tool_use_delta', id, input: fn.arguments };
          }
        }
      }

      if (choice.finish_reason) {
        for (const [, id] of activeTools) {
          yield { type: 'tool_use_end', id };
        }
        activeTools.clear();
        if (choice.finish_reason === 'stop' || choice.finish_reason === 'length') {
          yield { type: 'done', stopReason: choice.finish_reason === 'stop' ? 'end_turn' : 'max_tokens' };
        }
      }
    }
  }
}

export const openrouterProvider: Provider = {
  name: 'openrouter',
  stream: streamOpenRouter,
};
