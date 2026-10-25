import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent } from '../agent/runner.js';
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

test('OpenRouter accepts a 202 response when it contains a streamed completion', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response([
      'data: {"choices":[{"delta":{"content":"accepted"},"finish_reason":"stop"}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'), {
      status: 202,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  };

  try {
    const events = [];
    for await (const event of openrouterProvider.stream(
      [{ role: 'user', content: 'hello' }],
      [],
      { apiKey: 'test-key', model: 'openrouter/free' },
    )) {
      events.push(event);
    }
    assert.equal(requests, 1);
    assert.deepEqual(events, [
      { type: 'text_delta', text: 'accepted' },
      { type: 'done', stopReason: 'end_turn' },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenRouter emits only one completion event when the stream repeats its finish chunk', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response([
    'data: {"choices":[{"delta":{"content":"complete"},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    '',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    '',
    'data: [DONE]',
    '',
  ].join('\n'), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });

  try {
    const events = [];
    for await (const event of openrouterProvider.stream(
      [{ role: 'user', content: 'hello' }],
      [],
      { apiKey: 'test-key', model: 'openrouter/free' },
    )) {
      events.push(event);
    }
    assert.equal(events.filter(event => event.type === 'done').length, 1);
    assert.deepEqual(events, [
      { type: 'text_delta', text: 'complete' },
      { type: 'done', stopReason: 'end_turn' },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenRouter fails explicitly on a 202 async acknowledgement it cannot poll', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response('{"id":"async-job-1"}', {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const stream = openrouterProvider.stream(
      [{ role: 'user', content: 'hello' }],
      [],
      { apiKey: 'test-key', model: 'openrouter/free' },
    );
    await assert.rejects(async () => {
      for await (const _event of stream) { /* expected unsupported async acknowledgement */ }
    }, /accepted this request asynchronously \(202\).*cannot poll.*async-job-1/);
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('agent stops after one OpenRouter 429 instead of looping', async () => {
  const originalFetch = globalThis.fetch;
  const originalCwd = process.cwd();
  const testWorkspace = mkdtempSync(join(tmpdir(), 'symbiote-openrouter-test-'));
  let requests = 0;
  let iterations = 0;
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
    process.chdir(testWorkspace);
    await assert.rejects(runAgent(
      [{ role: 'user', content: 'hello' }],
      {
        provider: openrouterProvider,
        providerConfig: { apiKey: 'test-key', model: 'openrouter/free' },
        toolRegistry: {
          toProviderFormat: () => [],
          execute: async () => '',
          list: () => [],
        },
        maxIterations: 5,
        onProgress: event => {
          if (event.type === 'iteration') iterations++;
        },
      },
    ), /OpenRouter API error 429: Request limit reached/);
    assert.equal(requests, 1);
    assert.equal(iterations, 1);
  } finally {
    process.chdir(originalCwd);
    globalThis.fetch = originalFetch;
    rmSync(testWorkspace, { recursive: true, force: true });
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

test('429 retry honors Retry-After metadata and continues transient retries independently', async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    if (requests === 1) return new Response('server unavailable', { status: 503 });
    if (requests === 2) {
      return new Response(JSON.stringify({
        error: { metadata: { headers: { 'Retry-After': '0' } } },
      }), { status: 429 });
    }
    return new Response('ok', { status: 200 });
  };
  globalThis.setTimeout = ((callback: TimerHandler) => originalSetTimeout(callback, 0)) as typeof setTimeout;

  try {
    const response = await fetchWithRetry('https://provider.invalid', {});
    assert.equal(response.status, 200);
    assert.equal(requests, 3);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('429 backoff is interrupted promptly when the caller aborts', async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response('rate limited', {
      status: 429,
      headers: { 'Retry-After': '1' },
    });
  };

  try {
    const request = fetchWithRetry('https://provider.invalid', { signal: controller.signal });
    setTimeout(() => controller.abort(new DOMException('User interrupted', 'AbortError')), 10);
    await assert.rejects(request, /User interrupted/);
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