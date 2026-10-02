import test from 'node:test';
import assert from 'node:assert/strict';
import { openrouterProvider } from '../providers/openrouter.js';
import { fetchWithRetry } from '../providers/retry.js';

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

test('fetch retry wrapper preserves user cancellation and does not retry it', async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let requests = 0;
  globalThis.fetch = async (_input, init) => {
    requests++;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
  };

  try {
    const request = fetchWithRetry('https://provider.invalid', { signal: controller.signal }, 60_000);
    setTimeout(() => controller.abort(new DOMException('User interrupted', 'AbortError')), 10);
    await assert.rejects(request, /User interrupted/);
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});