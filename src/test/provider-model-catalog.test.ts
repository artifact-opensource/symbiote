import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverProviderModels } from '../providers/model-catalog.js';

test('model discovery queries the configured provider endpoint and caches the result', async () => {
  let requestUrl = '';
  let authorization = '';
  let calls = 0;
  const fetcher: typeof fetch = async (input, init) => {
    calls++;
    requestUrl = String(input);
    authorization = new Headers(init?.headers).get('authorization') ?? '';
    return new Response(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const config = { baseUrl: 'https://catalog-test.example/v1', apiKey: 'test-key' };
  const first = await discoverProviderModels('freeai', config, { fetcher });
  const second = await discoverProviderModels('freeai', config, { fetcher });

  assert.equal(requestUrl, 'https://catalog-test.example/v1/models');
  assert.equal(authorization, 'Bearer test-key');
  assert.deepEqual(first, ['model-a', 'model-b']);
  assert.deepEqual(second, first);
  assert.equal(calls, 1);
});

test('FreeAI model discovery requires a key before contacting the endpoint', async () => {
  let requestCount = 0;
  await assert.rejects(
    discoverProviderModels('freeai', { baseUrl: 'https://catalog-missing-key.example/v1' }, {
      fetcher: async () => {
        requestCount++;
        return new Response(null, { status: 401 });
      },
    }),
    /FREEAI_API_KEY/,
  );
  assert.equal(requestCount, 0);
});

test('Gemini model discovery normalizes resource names and uses the API-key header', async () => {
  let requestUrl = '';
  let apiKeyHeader = '';
  const fetcher: typeof fetch = async (input, init) => {
    requestUrl = String(input);
    apiKeyHeader = new Headers(init?.headers).get('x-goog-api-key') ?? '';
    return new Response(JSON.stringify({ models: [{ name: 'models/gemini-test' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const models = await discoverProviderModels(
    'gemini',
    { baseUrl: 'https://catalog-test.example/v1beta', apiKey: 'test-gemini-key' },
    { fetcher },
  );

  assert.equal(requestUrl, 'https://catalog-test.example/v1beta/models');
  assert.equal(apiKeyHeader, 'test-gemini-key');
  assert.deepEqual(models, ['gemini-test']);
});

test('Cloudflare discovery returns selectable model names instead of catalog UUIDs', async () => {
  let requestUrl = '';
  let authorization = '';
  const fetcher: typeof fetch = async (input, init) => {
    requestUrl = String(input);
    authorization = new Headers(init?.headers).get('authorization') ?? '';
    return new Response(JSON.stringify({
      success: true,
      result: [
        {
          id: 'catalog-uuid-qwen',
          name: '@cf/qwen/qwen3.8-27b',
          task: { name: 'Text Generation' },
        },
        {
          id: 'catalog-uuid-embedding',
          name: '@cf/qwen/qwen3-embedding-0.6b',
          task: { name: 'Text Embeddings' },
        },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const models = await discoverProviderModels('cloudflare', {
    accountId: 'a'.repeat(32),
    apiKey: 'test-cloudflare-key',
  }, { fetcher });

  assert.match(requestUrl, /\/accounts\/a{32}\/ai\/models\/search/);
  assert.equal(authorization, 'Bearer test-cloudflare-key');
  assert.deepEqual(models, ['@cf/qwen/qwen3.8-27b']);
});
