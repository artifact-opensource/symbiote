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

test('OpenRouter rate-limit errors report provider-supplied limit and reset metadata', async () => {
  const originalFetch = globalThis.fetch;
  const resetAt = Date.now() + 60 * 60 * 1000;
  const responseBody = {
    error: {
      message: 'Request limit reached',
      metadata: {
        headers: {
          'X-RateLimit-Limit': '1000',
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(resetAt),
        },
        remedy_hint: 'Check your provider account limits.',
      },
    },
  };
  globalThis.fetch = async () => new Response(JSON.stringify(responseBody), { status: 429 });

  try {
    const stream = openrouterProvider.stream(
      [{ role: 'user', content: 'hello' }],
      [],
      { apiKey: 'test-key', model: 'openrouter/free' },
    );
    await assert.rejects(async () => {
      for await (const _event of stream) { /* expected provider failure */ }
    }, error => {
      assert.match((error as Error).message, /limit 1000; 0 remaining/);
      assert.match((error as Error).message, new RegExp(new Date(resetAt).toISOString()));
      assert.match((error as Error).message, /Check your provider account limits/);
      assert.doesNotMatch((error as Error).message, /50 requests|midnight UTC/);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('429 retry returns immediately when provider reset is outside the bounded retry window', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response(JSON.stringify({
      error: {
        message: 'Request limit reached',
        metadata: {
          headers: {
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': String(Date.now() + 60 * 60 * 1000),
          },
        },
      },
    }), { status: 429 });
  };

  try {
    const response = await fetchWithRetry('https://provider.invalid', {});
    assert.equal(response.status, 429);
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