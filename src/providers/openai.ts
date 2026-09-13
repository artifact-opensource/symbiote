// Symbiote — OpenAI Chat Completions streaming provider (raw HTTP)

import type { Message, ToolDef, ProviderConfig, StreamEvent, Provider } from './types.js';
import { fetchWithRetry } from './retry.js';

const DEFAULT_BASE_URL = 'https://api.openai.com';

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
      // Always use empty string for content (not null) — some backends
      // interpret null content on assistant messages as prefill attempts
      const content = typeof msg.content === 'string' && msg.content.trim() ? msg.content : '';
      out.push({
        role: 'assistant',
        content,
        tool_calls: msg.tool_calls.map(tc => {
          const call: Record<string, unknown> = {
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.input) },
          };
          // Preserve provider-specific metadata (e.g. Gemini thought_signature)
          if (tc.extra) Object.assign(call, tc.extra);
          return call;
        }),
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

async function* streamOpenAI(
  messages: Message[],
  tools: ToolDef[],
  config: ProviderConfig,
): AsyncIterable<StreamEvent> {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;

  const body: Record<string, unknown> = {
    model: config.model,
    stream: true,
    stream_options: { include_usage: true },
    messages: convertMessages(messages),
  };
  if (config.maxTokens) body.max_tokens = config.maxTokens;
  if (config.temperature !== undefined) body.temperature = config.temperature;
  if (tools.length > 0) body.tools = convertTools(tools);

  // Some endpoints (GitHub Copilot) don't use the /v1 prefix
  const endpoint = baseUrl.includes('githubcopilot.com') || baseUrl.includes('localhost')
    ? `${baseUrl}/chat/completions`
    : `${baseUrl}/v1/chat/completions`;
  const extraHeaders = (config as unknown as Record<string, unknown>).extraHeaders as Record<string, string> | undefined;
  const res = await fetchWithRetry(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey ?? ''}`,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(((config as unknown as Record<string, unknown>).timeoutMs as number) ?? 120_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${text}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';
  // Track active tool calls by index
  const activeTools = new Map<number, string>(); // index → id
  const toolExtras = new Map<string, Record<string, unknown>>(); // id → extra metadata (e.g. thought_signature)

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

      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(data); } catch { continue; }

      // Usage chunk (final)
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
            // Capture provider-specific metadata (e.g. Gemini thought_signature)
            if (tc.extra_content) {
              toolExtras.set(tc.id, { extra_content: tc.extra_content });
            }
            yield { type: 'tool_use_start', id: tc.id, name: (fn?.name as string) ?? '', extra: toolExtras.get(tc.id) };
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
        // Close any active tool calls
        for (const [, id] of activeTools) {
          yield { type: 'tool_use_end', id };
        }
        activeTools.clear();
        if (finishReason === 'stop' || finishReason === 'length') {
          yield { type: 'done', stopReason: finishReason === 'stop' ? 'end_turn' : 'max_tokens' };
        }
        // tool_calls finish reason — don't yield done, [DONE] SSE will follow
        // but if it doesn't, the stream reader will exit on its own
      }
    }
  }
}

export const openaiProvider: Provider = {
  name: 'openai',
  stream: streamOpenAI,
};
