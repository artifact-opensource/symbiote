/**
 * NVIDIA NIM provider — OpenAI-compatible chat completions API.
 *
 * API reference: https://docs.nvidia.com/nim/large-language-models/latest/api-reference.html
 * Models:       https://build.nvidia.com/explore/discover#llm
 */

import type { Message, ToolDef, ProviderConfig, StreamEvent, Provider } from './types.js';
import { fetchWithRetry } from './retry.js';

const DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com';
const DEFAULT_MODEL = 'meta/llama-4-maverick-17b-128e-instruct';

function convertMessages(messages: Message[]): unknown[] {
  const out: unknown[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') {
      out.push({ role: 'system', content: typeof msg.content === 'string' ? msg.content : msg.content.map(b => b.text ?? '').join('') });
      continue;
    }
    if (msg.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: msg.tool_call_id, content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) });
      continue;
    }
    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      const content = typeof msg.content === 'string' && msg.content.trim() ? msg.content : '';
      out.push({
        role: 'assistant',
        content,
        tool_calls: msg.tool_calls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.input) },
        })),
      });
      continue;
    }
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

async function* streamNVIDIA(
  messages: Message[],
  tools: ToolDef[],
  config: ProviderConfig,
): AsyncIterable<StreamEvent> {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const model = config.model ?? DEFAULT_MODEL;

  const body: Record<string, unknown> = {
    model,
    stream: true,
    stream_options: { include_usage: true },
    messages: convertMessages(messages),
    temperature: config.temperature ?? 1.0,
    top_p: 1.0,
    frequency_penalty: 0.0,
    presence_penalty: 0.0,
  };
  if (config.maxTokens) body.max_tokens = config.maxTokens;
  if (tools.length > 0) body.tools = convertTools(tools);

  const res = await fetchWithRetry(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey ?? ''}`,
      'Accept': 'text/event-stream',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(((config as unknown as Record<string, unknown>).timeoutMs as number) ?? 120_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`NVIDIA API error ${res.status}: ${text}`);
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
        for (const [, id] of Array.from(activeTools.entries())) {
          yield { type: 'tool_use_end', id };
        }
        yield { type: 'done', stopReason: 'end_turn' };
        return;
      }

      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(data); } catch { continue; }

      // Usage chunk
      const usage = parsed.usage as Record<string, number> | undefined;
      if (usage && usage.total_tokens) {
        yield {
          type: 'usage',
          usage: {
            inputTokens: usage.prompt_tokens ?? 0,
            outputTokens: usage.completion_tokens ?? 0,
          },
        };
      }

      const choices = parsed.choices as Array<Record<string, unknown>> | undefined;
      if (!choices?.length) continue;

      const choice = choices[0];
      const delta = choice.delta as Record<string, unknown> | undefined;
      if (!delta) continue;

      // Text content
      if (delta.content && typeof delta.content === 'string') {
        yield { type: 'text_delta', text: delta.content };
      }

      // Tool calls
      const toolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined;
      if (toolCalls) {
        for (const tc of toolCalls) {
          const idx = tc.index as number;
          const fn = tc.function as Record<string, unknown> | undefined;

          if (tc.id && typeof tc.id === 'string') {
            activeTools.set(idx, tc.id);
            yield { type: 'tool_use_start', id: tc.id, name: (fn?.name as string) ?? '' };
          }

          if (fn?.arguments && typeof fn.arguments === 'string') {
            const id = activeTools.get(idx) ?? `tool_${idx}`;
            yield { type: 'tool_use_delta', id, input: fn.arguments };
          }
        }
      }

      // Finish reason
      const finishReason = choice.finish_reason as string | null;
      if (finishReason) {
        for (const [, id] of Array.from(activeTools.entries())) {
          yield { type: 'tool_use_end', id };
        }
        activeTools.clear();
        if (finishReason === 'stop' || finishReason === 'length') {
          yield { type: 'done', stopReason: finishReason === 'stop' ? 'end_turn' : 'max_tokens' };
        }
      }
    }
  }
}

export const nvidiaProvider: Provider = {
  name: 'nvidia',
  stream: streamNVIDIA,
};
