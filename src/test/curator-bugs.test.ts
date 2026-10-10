import test from 'node:test';
import assert from 'node:assert/strict';
import { Curator, type InteractionRecord } from '../curator/curator.js';
import { summarizeToolResults } from '../orchestrator/integration.js';

const record = (toolResults: InteractionRecord['toolResults']): InteractionRecord => ({
  id: 'i', timestamp: new Date().toISOString(), taskType: 'conversation', provider: 'p', model: 'm',
  tokensUsed: 10, latencyMs: 10, toolSuccess: true, userSatisfied: true, toolCallCount: toolResults?.length ?? 0,
  delivered: true, channel: 'test', routingWasOptimal: true, toolResults,
});

test('summarizeToolResults flags errors, non-zero exits and is_error payloads', () => {
  const out = summarizeToolResults([
    { name: 'read', input: {}, result: 'file contents' },
    { name: 'exec', input: {}, result: 'boom\nExit code: 2' },
    { name: 'fs', input: {}, result: 'Error: Not found: x' },
    { name: 'web_fetch', input: {}, result: '{"error":"timeout","is_error":true}' },
  ]);
  assert.deepEqual(out.map(o => o.success), [true, false, false, false]);
});

test('curator escalates a repeatedly failing tool to a major bug', async () => {
  const curator = new Curator();
  let last: Awaited<ReturnType<Curator['reviewInteraction']>> = [];
  for (let i = 0; i < 3; i++) {
    last = await curator.reviewInteraction(record([{ tool: 'flaky_tool', success: false, error: 'ETIMEDOUT' }]));
  }
  assert.ok(last.some(p => p.severity === 'major' && /flaky_tool/.test(p.reason)));
});

test('curator stays quiet when every tool succeeds', async () => {
  const curator = new Curator();
  const proposals = await curator.reviewInteraction(record([{ tool: 'read', success: true }]));
  assert.equal(proposals.filter(p => p.severity === 'major').length, 0);
});
