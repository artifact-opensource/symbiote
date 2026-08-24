// Symbiote — Google Gemini native API streaming provider
// Uses the Gemini REST API directly (not OpenAI compatibility shim)
// Supports: streaming, function calling, thinking, system instructions

import type { Message, ToolDef, ProviderConfig, StreamEvent, Provider } from './types.js';
import { fetchWithRetry } from './retry.js';

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Convert Symbiote messages to Gemini Content[] format.
 * Gemini uses { role: "user"|"model", parts: [...] } — no "assistant" or "tool" roles.
 * System instructions are handled separately via systemInstruction.
 */
function convertMessages(messages: Message[]): { contents: unknown[]; systemInstruction?: unknown } {
  const contents: unknown[] = [];
  let systemInstruction: unknown = undefined;

  for (const msg of messages) {
    // System messages → systemInstruction (only the last one wins)
    if (msg.role === 'system') {
      const text = typeof msg.content === 'string'
        ? msg.content
        : msg.content.map(b => b.text ?? '').join('');
      systemInstruction = {
        parts: [{ text }],
      };
      continue;
    }

    // Tool result messages → user role with functionResponse part
    if (msg.role === 'tool') {
      const resultText = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      let parsedResult: unknown;
      try {
        parsedResult = JSON.parse(resultText);
      } catch {
        parsedResult = { result: resultText };
      }
      contents.push({
        role: 'user',
        parts: [{
          functionResponse: {
            name: msg.name ?? 'unknown',
            response: parsedResult,
          },
        }],
      });
      continue;
    }

    // Assistant messages with tool calls → model role with functionCall parts
    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      const parts: unknown[] = [];
      // Include any text content first
      const text = typeof msg.content === 'string' ? msg.content : msg.content?.map(b => b.text ?? '').join('') ?? '';
      if (text.trim()) {
        parts.push({ text });
      }
      // Add function calls — preserve thoughtSignature if present (REQUIRED by Gemini)
      for (const tc of msg.tool_calls) {
        const fcPart: Record<string, unknown> = {
          functionCall: {
            name: tc.name,
            args: tc.input,
          },
        };
        // Gemini requires thoughtSignature to be sent back on subsequent turns
        // when thinking is enabled. Missing it causes 400 INVALID_ARGUMENT.
        if (tc.extra?.thoughtSignature) {
          fcPart.thoughtSignature = tc.extra.thoughtSignature;
        }
        parts.push(fcPart);
      }
      contents.push({ role: 'model', parts });
      continue;
    }

    // Regular user/assistant messages
    const role = msg.role === 'assistant' ? 'model' : 'user';
    const text = typeof msg.content === 'string'
      ? msg.content
      : msg.content.map(b => b.text ?? '').join('');
    if (text.trim()) {
      contents.push({ role, parts: [{ text }] });
    }
  }

  return { contents, systemInstruction };
}

/**
 * Convert Symbiote ToolDef[] to Gemini functionDeclarations format.
 */
function convertTools(tools: ToolDef[]): unknown[] {
  if (tools.length === 0) return [];

  return [{
    functionDeclarations: tools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
  }];
}

async function* streamGemini(
  messages: Message[],
  tools: ToolDef[],
  config: ProviderConfig,
): AsyncIterable<StreamEvent> {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const apiKey = config.apiKey ?? process.env.GEMINI_API_KEY ?? '';
  const model = config.model;

  const { contents, systemInstruction } = convertMessages(messages);
  const geminiTools = convertTools(tools);

  const body: Record<string, unknown> = { contents };

  if (systemInstruction) {
    body.systemInstruction = systemInstruction;
  }

  if (geminiTools.length > 0) {
    body.tools = geminiTools;
  }

  // Generation config
  const generationConfig: Record<string, unknown> = {};
  if (config.maxTokens) generationConfig.maxOutputTokens = config.maxTokens;
  if (config.temperature !== undefined) generationConfig.temperature = config.temperature;

  // Thinking config — map from Symbiote's thinking budget to Gemini's thinkingLevel
  const thinkingBudget = (config as any).thinkingBudget ?? (config as any).thinking?.budget;
  if (thinkingBudget) {
    const levelMap: Record<string, string> = {
      none: 'none', off: 'none',
      low: 'low', minimal: 'low',
      medium: 'medium', default: 'medium',
      high: 'high', max: 'high',
    };
    generationConfig.thinkingConfig = {
      thinkingLevel: levelMap[thinkingBudget] ?? 'low',
    };
  }

  if (Object.keys(generationConfig).length > 0) {
    body.generationConfig = generationConfig;
  }

  // Gemini streaming endpoint: models/{model}:streamGenerateContent?alt=sse
  const endpoint = `${baseUrl}/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;

  const res = await fetchWithRetry(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(((config as any).timeoutMs as number) ?? 120_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${text}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';
  let toolCallCounter = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (!data) continue;

      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(data); } catch { continue; }

      // Usage metadata
      const usageMeta = parsed.usageMetadata as Record<string, number> | undefined;
      if (usageMeta) {
        totalInputTokens = usageMeta.promptTokenCount ?? totalInputTokens;
        totalOutputTokens = usageMeta.candidatesTokenCount ?? totalOutputTokens;
      }

      const candidates = parsed.candidates as Array<Record<string, unknown>> | undefined;
      if (!candidates?.length) continue;

      const candidate = candidates[0];
      const content = candidate.content as Record<string, unknown> | undefined;
      if (!content) continue;

      const parts = content.parts as Array<Record<string, unknown>> | undefined;
      if (!parts) continue;

      for (const part of parts) {
        // Thinking/reasoning text (Gemini returns thought: true on thinking parts)
        if (part.thought === true && typeof part.text === 'string') {
          yield { type: 'thinking_delta', text: part.text };
          continue;
        }

        // Regular text (skip empty strings)
        if (typeof part.text === 'string' && !part.thought && part.text.length > 0) {
          yield { type: 'text_delta', text: part.text };
          continue;
        }

        // Function call
        const fc = part.functionCall as Record<string, unknown> | undefined;
        if (fc) {
          const id = `gemini_call_${toolCallCounter++}`;
          const name = fc.name as string;
          const args = fc.args as Record<string, unknown> ?? {};

          // Preserve thoughtSignature — Gemini REQUIRES it in subsequent turns
          // when thinking is enabled. Without it: 400 INVALID_ARGUMENT.
          const extra: Record<string, unknown> = {};
          if (part.thoughtSignature) {
            extra.thoughtSignature = part.thoughtSignature;
          }

          yield { type: 'tool_use_start', id, name, extra: Object.keys(extra).length > 0 ? extra : undefined };
          yield { type: 'tool_use_delta', id, input: JSON.stringify(args) };
          yield { type: 'tool_use_end', id };
        }
      }

      // Finish reason — Gemini uses STOP, MAX_TOKENS, SAFETY, RECITATION, etc.
      const finishReason = candidate.finishReason as string | undefined;
      if (finishReason === 'SAFETY' || finishReason === 'RECITATION') {
        yield { type: 'done', stopReason: 'content_filter' };
        return;
      }
    }
  }

  // Emit usage
  if (totalInputTokens || totalOutputTokens) {
    yield {
      type: 'usage',
      usage: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
      },
    };
  }

  yield { type: 'done', stopReason: 'end_turn' };
}

export const geminiProvider: Provider = {
  name: 'gemini',
  stream: streamGemini,
};
