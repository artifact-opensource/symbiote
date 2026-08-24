// Symbiote — OmniRoute provider: seamless multi-model failover
import type { Message, ToolDef, ProviderConfig, StreamEvent, Provider } from './types.js';
import { fetchWithRetry } from './retry.js';

const DEFAULT_TIMEOUT_MS = 120_000;

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
        console.warn(`[omniroute] Skipping non-contiguous or orphaned tool result: ${msg.tool_call_id ?? 'missing-id'}`);
        continue;
      }
      pendingToolCallIds.delete(msg.tool_call_id);
      out.push({ role: 'tool', tool_call_id: msg.tool_call_id, content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) });
      continue;
    }
    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      const content = typeof msg.content === 'string' && msg.content.trim() ? msg.content : '';
      const validToolCalls = msg.tool_calls
        .filter(tc => tc.name && /^[a-zA-Z0-9_.\\-]+$/.test(tc.name));
      pendingToolCallIds = new Set(validToolCalls.map(tc => tc.id));
      out.push({
        role: 'assistant',
        content,
        tool_calls: validToolCalls
          .map(tc => {
            const call: Record<string, unknown> = {
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: JSON.stringify(tc.input) },
            };
            if (tc.extra) Object.assign(call, tc.extra);
            return call;
          }),
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

function getEndpoint(baseUrl: string): string {
  if (baseUrl.includes('githubcopilot.com') || baseUrl.includes('localhost')) {
    return `${baseUrl}/chat/completions`;
  }
  return baseUrl.endsWith('/v1') ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;
}

async function* streamOmniroute(
  messages: Message[],
  tools: ToolDef[],
  config: ProviderConfig,
): AsyncIterable<StreamEvent> {
  const baseUrl = config.baseUrl ?? '';
  if (!baseUrl) {
    throw new Error('OmniRoute provider requires baseUrl in config');
  }

  const anyConfig = config as any;
  const modelList: string[] = [];
  const modelsAny = anyConfig.models as any;
  if (modelsAny) {
    const primary = modelsAny.primary;
    const fallback = modelsAny.fallback;
    if (typeof primary === 'string') modelList.push(primary);
    if (Array.isArray(fallback)) {
      for (const m of fallback) {
        if (typeof m === 'string') modelList.push(m);
      }
    }
  }
  if (modelList.length === 0 && typeof config.model === 'string') {
    modelList.push(config.model);
  }
  if (modelList.length === 0) {
    throw new Error('OmniRoute provider: no models specified');
  }

  const endpoint = getEndpoint(baseUrl);
  const timeoutMs = anyConfig.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  for (const model of modelList) {
    const body: Record<string, unknown> = {
      model,
      stream: true,
      stream_options: { include_usage: true },
      messages: convertMessages(messages),
    };
    if (config.maxTokens) {
      if (typeof model === 'string' && model.startsWith('gpt-5')) {
        body.max_completion_tokens = config.maxTokens;
      } else {
        body.max_tokens = config.maxTokens;
      }
    }
    if (config.temperature !== undefined) body.temperature = config.temperature;
    if (tools.length > 0) body.tools = convertTools(tools);

    const extraHeaders = anyConfig.extraHeaders ?? {};
    try {
      const res = await fetchWithRetry(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
          ...extraHeaders,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        const text = await res.text();
        console.warn(`[omniroute] Model ${model} failed with status ${res.status}: ${text}`);
        continue;
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';
      const activeTools = new Map<number, string>();
      const toolExtras = new Map<string, Record<string, unknown>>();
      const toolNames = new Map<number, string>();
      const toolStartEmitted = new Set<number>();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\\n');
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
          if (delta) {
            if (typeof delta.content === 'string') {
              yield { type: 'text_delta', text: delta.content };
            }
            if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
              for (let idx = 0; idx < delta.tool_calls.length; idx++) {
                const tc = delta.tool_calls[idx] as Record<string, unknown>;
                const id = String(tc.id ?? `tool_${idx}`);
                const name = String(tc.name ?? '');
                const args = String(tc.arguments ?? '');
                const extra = tc.extra as Record<string, unknown> | undefined;
                if (!activeTools.has(idx) && (name || (args && typeof args === 'string'))) {
                  activeTools.set(idx, id);
                  if (name) toolNames.set(idx, name);
                  if (extra) toolExtras.set(id, extra);
                  yield {
                    type: 'tool_use_start',
                    id,
                    name: name || 'unknown_tool',
                    extra,
                  };
                }
                if (args && typeof args === 'string') {
                  yield { type: 'tool_use_delta', id, input: args };
                }
              }
            }
          }

          const finishReason = choice.finish_reason as string | null;
          if (finishReason) {
            for (const [, id] of activeTools) {
              yield { type: 'tool_use_end', id };
            }
            activeTools.clear();
            toolNames.clear();
            toolStartEmitted.clear();
            if (finishReason === 'stop' || finishReason === 'length') {
              yield { type: 'done', stopReason: finishReason === 'stop' ? 'end_turn' : 'max_tokens' };
              return;
            }
          }
        }
      }
      // Success: break out of model loop
      return;
    } catch (err) {
      console.warn(`[omniroute] Model ${model} threw error: ${err}`);
      // continue to next model
    }
  }
  throw new Error('OmniRoute provider: all models failed');
}

export const omnirouteProvider: Provider = {
  name: 'omniroute',
  stream: streamOmniroute,
};
