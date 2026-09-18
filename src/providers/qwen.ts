// Qwen provider (Hugging Face Inference API)

import type { Message, ToolDef, ProviderConfig, StreamEvent, Provider } from './types.js';

function messagesToPrompt(messages: Message[]) {
  return messages.map(m => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`).join('\n');
}

async function* streamQwen(messages: Message[], _tools: ToolDef[], config: ProviderConfig): AsyncIterable<StreamEvent> {
  const model = config.model || 'Qwen/qwen3-0.6b';
  const apiKey = config.apiKey ?? process.env.HUGGINGFACE_API_KEY ?? process.env.HF_API_KEY ?? '';
  const url = `https://api-inference.huggingface.co/models/${model}`;

  const body: Record<string, unknown> = {
    inputs: messagesToPrompt(messages),
    parameters: {
      max_new_tokens: config.maxTokens ?? 512,
      temperature: config.temperature ?? 0.2,
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'User-Agent': 'Symbiote/QwenProvider',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeoutMs ?? 120_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Hugging Face inference error ${res.status}: ${text}`);
  }

  const data: unknown = await res.json();
  let text = '';
  if (typeof data === 'string') {
    text = data;
  } else if (Array.isArray(data) && data[0] && typeof data[0] === 'object') {
    const first = data[0] as Record<string, unknown>;
    text = typeof first.generated_text === 'string'
      ? first.generated_text
      : typeof first.text === 'string'
        ? first.text
        : JSON.stringify(first);
  } else if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    text = typeof obj.generated_text === 'string' ? obj.generated_text : JSON.stringify(obj);
  } else {
    text = JSON.stringify(data);
  }

  yield { type: 'text_delta', text };
  yield { type: 'done', stopReason: 'completed' };
}

export const qwenProvider: Provider = {
  name: 'qwen',
  stream: streamQwen,
};
