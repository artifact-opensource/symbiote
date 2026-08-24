import assert from 'node:assert/strict';
import { ollamaProvider } from '../src/providers/ollama.js';

async function main() {
  const events: Array<{ type: string; text?: string }> = [];

  for await (const event of ollamaProvider.stream(
    [{ role: 'user', content: 'Say hello in one short sentence.' }],
    [{ name: 'noop', description: 'No-op tool', parameters: { type: 'object', properties: {} } }],
    {
      model: 'Artifact_Virtual/raven:v1.1-ollama',
      baseUrl: 'http://127.0.0.1:11434',
      apiKey: 'ollama',
      timeoutMs: 120000,
    },
  )) {
    events.push(event as { type: string; text?: string });
  }

  const sawText = events.some((event) => event.type === 'text_delta' && typeof event.text === 'string' && event.text.trim().length > 0);
  const sawDone = events.some((event) => event.type === 'done');
  assert.ok(sawText || sawDone, `Expected a successful Ollama response, got ${JSON.stringify(events)}`);
  console.log('ollama-tools regression test passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
