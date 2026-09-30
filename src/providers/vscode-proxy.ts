// VS Code Proxy Provider
// Calls the local VS Code bridge server which routes through Copilot
// Falls back to direct calls if bridge isn't running

import type { Message, ToolDef, ProviderConfig, StreamEvent, Provider } from './types.js';

const BRIDGE_URL = process.env.VSCODE_BRIDGE_URL || 'http://127.0.0.1:3033';

export const vscodeProxyProvider: Provider = {
  name: 'vscode-proxy',

  async *stream(
    messages: Message[],
    tools: ToolDef[],
    config: ProviderConfig,
  ): AsyncIterable<StreamEvent> {
    try {
      const response = await callVsCodeBridge(messages, config);
      
      // Stream the response character by character
      for (const char of response) {
        yield { type: 'text_delta', text: char };
      }
      
      yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } };
      yield { type: 'done', stopReason: 'stop' };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      yield { type: 'text_delta', text: `Error: ${errorMsg}` };
      yield { type: 'done', stopReason: 'error' };
    }
  },
};

async function callVsCodeBridge(messages: Message[], config: ProviderConfig): Promise<string> {
  const payload = {
    messages: messages.map((m) => ({
      role: m.role,
      content: Array.isArray(m.content)
        ? m.content.map((c) => (typeof c === 'string' ? c : c.text || '')).join('')
        : m.content,
    })),
    maxTokens: config.maxTokens || 4096,
  };

  const response = await fetch(`${BRIDGE_URL}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60000),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`VS Code bridge error (${response.status}): ${error}`);
  }

  const data = (await response.json()) as { message: string; error?: string };
  if (data.error) throw new Error(data.error);

  return data.message;
}

export default vscodeProxyProvider;
