import test from 'node:test';
import assert from 'node:assert/strict';
import { openrouterProvider } from '../providers/openrouter.js';

test('OpenRouter 401 fails immediately with actionable authentication guidance', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response('{"error":{"message":"Missing Authentication header"}}', { status: 401 });
  };

  try {
    const stream = openrouterProvider.stream(
      [{ role: 'user', content: 'hello' }],
      [],
      { apiKey: 'test-key', model: 'openrouter/free' },
    );
    await assert.rejects(async () => {
      for await (const _event of stream) { /* expected request failure */ }
    }, /authentication failed \(401\).*Bearer authorization header.*Missing Authentication header/i);
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});