// Symbiote — FreeTheAi Provider (OpenAI-compatible)

import type { Message, ToolDef, ProviderConfig, StreamEvent, Provider } from './types.js';
import { fetchWithRetry } from './retry.js';

const DEFAULT_BASE_URL = 'https://api.freetheai.xyz/v1';

function convertMessages(messages: Message[]): unknown[] {
  return messages.map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }));
}

function convertTools(tools: ToolDef[]): unknown[] {
  return tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

async function* streamFreeAI(messages: Message[], tools: ToolDef[], config: ProviderConfig): AsyncIterable<StreamEvent> {
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
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeoutMs ?? 300_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`FreeAI API error ${res.status}: ${text}`);
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
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') {
        yield { type: 'done', stopReason: 'end_turn' };
        return;
      }

      let parsed: any;
      try { parsed = JSON.parse(data); } catch { continue; }

      if (parsed.usage) {
        yield { type: 'usage', usage: { inputTokens: parsed.usage.prompt_tokens ?? 0, outputTokens: parsed.usage.completion_tokens ?? 0 } };
      }

      const choices = parsed.choices as any[];
      if (!choices?.length) continue;
      const choice = choices[0];
      const delta = choice.delta;

      if (delta?.content) yield { type: 'text_delta', text: delta.content };

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
        for (const [, id] of activeTools) yield { type: 'tool_use_end', id };
        activeTools.clear();
        if (choice.finish_reason === 'stop' || choice.finish_reason === 'length') {
          yield { type: 'done', stopReason: choice.finish_reason === 'stop' ? 'end_turn' : 'max_tokens' };
        }
      }
    }
  }
}

export const freeaiProvider: Provider = {
  name: 'free-ai',
  stream: streamFreeAI,
};
