// Symbiote — AI Horde Provider (OpenAI-compatible facade)
// Uses the anonymous OpenAI-compatible endpoint at oai.aihorde.net
// Default model: aphrodite/TheDrummer/Skyfall-31B-v4.2
// Anonymous key: 0000000000
//
// Horde's OpenAI facade does NOT reliably support SSE streaming, so this
// provider makes a single non-streaming fetch and converts the full
// response into StreamEvents.
import type { Message, ToolDef, ProviderConfig, StreamEvent, Provider } from './types.js';
import { fetchWithRetry } from './retry.js';

const DEFAULT_BASE_URL = 'https://oai.aihorde.net/v1';
const DEFAULT_MODEL = 'aphrodite/TheDrummer/Skyfall-31B-v4.2';
const DEFAULT_API_KEY = '0000000000'; // anonymous Horde key

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
        console.warn(`[aihorde] Skipping non-contiguous or orphaned tool result: ${msg.tool_call_id ?? 'missing-id'}`);
        continue;
      }
      pendingToolCallIds.delete(msg.tool_call_id);
      out.push({ role: 'tool', tool_call_id: msg.tool_call_id, content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) });
      continue;
    }
    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      const content = typeof msg.content === 'string' && msg.content.trim() ? msg.content : '';
      const validToolCalls = msg.tool_calls.filter(tc => tc.name && /^[a-zA-Z0-9_.\\-]+$/.test(tc.name));
      pendingToolCallIds = new Set(validToolCalls.map(tc => tc.id));
      out.push({
        role: 'assistant',
        content: content || null,
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

  if (out.length === 0) {
    out.push({ role: 'user', content: 'Hello' });
  }

  return out;
}

function convertTools(tools: ToolDef[]): unknown[] {
  return tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

async function* streamAihorde(
  messages: Message[],
  tools: ToolDef[],
  config: ProviderConfig,
): AsyncIterable<StreamEvent> {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;

  const body: Record<string, unknown> = {
    model: config.model ?? DEFAULT_MODEL,
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
      'Authorization': `Bearer ${config.apiKey ?? DEFAULT_API_KEY}`,
      'X-Title': 'Symbiote',
      'HTTP-Referer': 'https://github.com/Artifact-Virtual',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000), // 5 minutes — Horde queues can be slow
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Aihorde API error ${res.status}: ${text}`);
  }

  const data: any = await res.json();

  // Convert the single non-streaming response into StreamEvents
  const choices = data.choices as any[] | undefined;
  if (!choices?.length) {
    // No content returned — just signal done
    yield { type: 'done', stopReason: 'end_turn' };
    return;
  }

  const choice = choices[0];

  // Yield text content
  const content = choice.message?.content;
  if (content) {
    yield { type: 'text_delta', text: content };
  }

  // Yield tool calls if any
  const toolCalls = choice.message?.tool_calls as any[] | undefined;
  if (toolCalls?.length) {
    for (const tc of toolCalls) {
      if (tc.id) {
        yield { type: 'tool_use_start', id: tc.id, name: tc.function?.name ?? '' };
      }
      if (tc.function?.arguments) {
        yield { type: 'tool_use_delta', id: tc.id, input: tc.function.arguments };
      }
      if (tc.id) {
        yield { type: 'tool_use_end', id: tc.id };
      }
    }
  }

  // Yield usage if present
  // NOTE: Horde's facade returns `usage.kudos` instead of standard token counts
  if (data.usage) {
    yield {
      type: 'usage',
      usage: {
        inputTokens: data.usage.prompt_tokens ?? data.usage.kudos ?? 0,
        outputTokens: data.usage.completion_tokens ?? 0,
      },
    };
  }

  // Done
  if (choice.finish_reason) {
    const stopReason = choice.finish_reason === 'stop' || choice.finish_reason === 'length'
      ? (choice.finish_reason === 'stop' ? 'end_turn' : 'max_tokens')
      : 'end_turn';
    yield { type: 'done', stopReason };
  } else {
    yield { type: 'done', stopReason: 'end_turn' };
  }
}

export const aihordeProvider: Provider = {
  name: 'aihorde',
  stream: streamAihorde,
};
