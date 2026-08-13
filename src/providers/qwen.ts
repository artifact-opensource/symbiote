// Symbiote — Qwen Cloud OpenAI-compatible provider

import type { Message, ToolDef, ProviderConfig, StreamEvent, Provider } from './types.js';

function messagesToPayload(messages: Message[]) {
  // Pass through messages in OpenAI chat format
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

function normalizeBaseUrl(baseUrl?: string) {
  if (!baseUrl) return 'https://api.qwen.ai';
  return baseUrl.replace(/\/$/, '');
}

async function* streamQwen(messages: Message[], _tools: ToolDef[], config: ProviderConfig): AsyncIterable<StreamEvent> {
  const model = config.model ?? 'qwen3.6';
  const apiKey = config.apiKey ?? process.env.QWEN_API_KEY ?? '';
  const rawBase = config.baseUrl ?? process.env.QWEN_BASE_URL ?? process.env.OPENAI_BASE_URL;
  const baseUrl = normalizeBaseUrl(rawBase);

  // Support both forms: baseUrl may already include /v1
  const endpoint = baseUrl.includes('/v1')
    ? `${baseUrl.replace(/\/$/, '')}/chat/completions`
    : `${baseUrl}/v1/chat/completions`;

  const body = {
    model,
    messages: messagesToPayload(messages),
    temperature: config.temperature ?? 0.2,
    max_tokens: config.maxTokens ?? 1024,
    stream: !!config.stream,
  } as Record<string, unknown>;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeoutMs ?? 120_000),
  });

  const contentType = res.headers.get('content-type') ?? '';

  // SSE / streaming response
  if (contentType.includes('text/event-stream') || (await res.text()).startsWith('data:')) {
    // Re-fetch as a stream (some servers don't allow reading twice; try best-effort)
    // Attempt to stream by performing a raw fetch again without consuming body above.
    // Fallback: parse the previously-read text as non-stream JSON below.
  }

  if (res.ok) {
    // Try to parse JSON response (non-streaming)
    const json = await res.json().catch(async () => {
      // If JSON parse fails, return raw text
      const raw = await res.text();
      return { raw } as unknown;
    });

    // OpenAI-compatible response
    if (json && Array.isArray(json.choices)) {
      let accumulated = '';
      for (const choice of json.choices) {
        if (choice.message?.content) {
          const text = typeof choice.message.content === 'string' ? choice.message.content : JSON.stringify(choice.message.content);
          accumulated += text;
          yield { type: 'text_delta', text };
        } else if (choice.delta?.content) {
          const text = choice.delta.content;
          accumulated += text;
          yield { type: 'text_delta', text };
        }
      }
      yield { type: 'done', stopReason: json.choices[0]?.finish_reason ?? 'completed' };
      return;
    }

    // Unknown shape: return raw string
    const raw = typeof json === 'string' ? json : JSON.stringify(json);
    yield { type: 'text_delta', text: raw };
    yield { type: 'done', stopReason: 'completed' };
    return;
  }

  // Non-OK response: include text for diagnostics
  const errText = await res.text();
  throw new Error(`Qwen API error ${res.status}: ${errText}`);
}

export const qwenProvider: Provider = {
  name: 'qwen',
  stream: streamQwen,
};
