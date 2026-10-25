import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Provider } from '../providers/types.js';
import { selectProviderRoute } from '../providers/route.js';
import { initSarsi, routeProvider } from '../sarsi/loader.js';

test('SARSI P1-P5 routes use valid providers and the supported Groq model ID', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'symbiote-routing-'));

  try {
    const store = initSarsi(stateDir);
    const expected = [
      ['code', 'openrouter', 'openrouter/free'],
      ['reasoning', 'openrouter', 'openrouter/free'],
      ['creative', 'openrouter', 'openrouter/free'],
      ['simple_qa', 'openrouter', 'openrouter/free'],
      ['long_context', 'openrouter', 'openrouter/free'],
    ] as const;

    for (const [taskType, provider, model] of expected) {
      assert.deepEqual(
        (({ provider: actualProvider, model: actualModel }) => [actualProvider, actualModel])(routeProvider(taskType)!),
        [provider, model],
        `unexpected route for ${taskType}`,
      );
    }

    const persisted = store.load();
    persisted.providerRules.find(rule => rule.id === 'p1')!.model = 'openrouter/free';
    store.save(persisted);
    initSarsi(stateDir);
    assert.equal(routeProvider('code')?.model, 'openrouter/free');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('SARSI route selection falls back without credentials and selects configured providers', () => {
  const fallbackProvider: Provider = { name: 'openrouter', async *stream() {} };
  const groqProvider: Provider = { name: 'groq', async *stream() {} };
  const providers = new Map<string, Provider>([
    ['openrouter', fallbackProvider],
    ['groq', groqProvider],
  ]);
  const previousGroqKey = process.env.GROQ_API_KEY;
  delete process.env.GROQ_API_KEY;

  try {
    const fallback = selectProviderRoute(
      { provider: 'groq', model: 'llama-3.3-70b-versatile' },
      providers,
      {},
      { name: 'openrouter', provider: fallbackProvider, model: 'openrouter/free' },
    );
    assert.equal(fallback.name, 'openrouter');
    assert.equal(fallback.routed, false);

    const notExplicitlyAllowed = selectProviderRoute(
      { provider: 'groq', model: 'llama-3.3-70b-versatile' },
      providers,
      { groq: { apiKey: 'test-key', model: 'llama-3.3-70b-versatile' } },
      { name: 'openrouter', provider: fallbackProvider, model: 'openrouter/free' },
    );
    assert.equal(notExplicitlyAllowed.name, 'openrouter');
    assert.equal(notExplicitlyAllowed.routed, false);

    const routed = selectProviderRoute(
      { provider: 'groq', model: 'llama-3.3-70b-versatile' },
      providers,
      { groq: { apiKey: 'test-key', model: 'llama-3.3-70b-versatile' } },
      { name: 'openrouter', provider: fallbackProvider, model: 'openrouter/free' },
      ['groq'],
    );
    assert.equal(routed.name, 'groq');
    assert.equal(routed.model, 'llama-3.3-70b-versatile');
    assert.equal(routed.routed, true);

    const unconfiguredModel = selectProviderRoute(
      { provider: 'groq', model: 'paid-model' },
      providers,
      { groq: { apiKey: 'test-key', model: 'llama-3.3-70b-versatile' } },
      { name: 'openrouter', provider: fallbackProvider, model: 'openrouter/free' },
      ['groq'],
    );
    assert.equal(unconfiguredModel.name, 'openrouter');
    assert.equal(unconfiguredModel.routed, false);
  } finally {
    if (previousGroqKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = previousGroqKey;
  }
});