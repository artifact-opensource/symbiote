import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Provider, StreamEvent } from '../providers/types.js';
import { runAgent } from '../agent/runner.js';
import { Curator, type InteractionRecord } from '../curator/curator.js';
import { MetaN } from '../meta/meta.js';
import { getSarsi, getSarsiModel, initSarsi, shutdownSarsi } from '../sarsi/index.js';

function tempDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-meta-learning-'));
}

function record(
  id: string,
  options: { good?: boolean; taskType?: string; routingRuleId?: string; provider?: string; toolResults?: InteractionRecord['toolResults'] } = {},
): InteractionRecord {
  const good = options.good ?? false;
  return {
    id,
    timestamp: new Date().toISOString(),
    taskType: options.taskType ?? 'simple_qa',
    provider: options.provider ?? 'openrouter',
    model: 'test-model',
    tokensUsed: good ? 100 : 2000,
    latencyMs: good ? 500 : 4000,
    toolSuccess: good,
    userSatisfied: good,
    toolCallCount: options.toolResults?.length ?? 0,
    delivered: true,
    channel: 'test',
    routingWasOptimal: good,
    routingRuleId: options.routingRuleId ?? 'p4',
    toolResults: options.toolResults,
  };
}

async function feed(meta: MetaN, prefix: string, good: boolean, extra?: Partial<InteractionRecord>): Promise<void> {
  for (let index = 0; index < 8; index++) {
    await meta.feedOutcome({ ...record(`${prefix}-${index}`, { good }), ...extra, id: `${prefix}-${index}` });
  }
}

test('Meta^n commits an improvement based on matched outcomes across restart', async () => {
  const directory = tempDirectory();
  const sarsiDirectory = path.join(directory, 'sarsi');
  const metaPath = path.join(directory, 'meta-state.json');

  try {
    initSarsi(sarsiDirectory);
    const curator = new Curator(path.join(directory, 'curator-state.json'));
    const meta = new MetaN(metaPath, curator);
    await feed(meta, 'baseline', false);
    await curator.reviewInteraction(record('proposal', { good: false }));

    await meta.runCycle();
    assert.equal(meta.getActiveCount(), 1);

    const restored = new MetaN(metaPath, new Curator(path.join(directory, 'curator-state.json')));
    assert.equal(restored.getActiveCount(), 1);
    await restored.feedOutcome(record('irrelevant', { good: true, taskType: 'creative', routingRuleId: 'p3', provider: 'openai' }));
    assert.equal(restored.getActiveCount(), 1);
    await feed(restored, 'candidate', true);

    assert.equal(restored.getActiveCount(), 0);
    assert.equal(restored.getHistory().at(-1)?.decision, 'commit');
    const appliedChange = getSarsiModel().ruleHistory.find(change => change.source === 'curator');
    assert.equal(appliedChange?.verified, true);
    assert.equal(getSarsiModel().ruleHistory.filter(change => change.id === appliedChange?.id).length, 1);
  } finally {
    shutdownSarsi();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Meta^n rolls back a demonstrated regression and records rollback once', async () => {
  const directory = tempDirectory();
  const sarsiDirectory = path.join(directory, 'sarsi');

  try {
    initSarsi(sarsiDirectory);
    const originalPriority = getSarsiModel().providerRules.find(rule => rule.id === 'p4')?.priority;
    const curator = new Curator(path.join(directory, 'curator-state.json'));
    const meta = new MetaN(path.join(directory, 'meta-state.json'), curator);
    await feed(meta, 'baseline-good', true);
    await curator.reviewInteraction(record('regression-proposal', { good: false }));
    await meta.runCycle();
    await feed(meta, 'candidate-bad', false);

    assert.equal(meta.getActiveCount(), 0);
    assert.equal(meta.getHistory().at(-1)?.decision, 'rollback');
    assert.equal(getSarsiModel().providerRules.find(rule => rule.id === 'p4')?.priority, originalPriority);
    const change = getSarsiModel().ruleHistory.find(entry => entry.source === 'curator');
    assert.equal(change?.rollback, false);
    assert.equal(getSarsi().rollback(change!.id), false);
  } finally {
    shutdownSarsi();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Meta^n does not count duplicate or unrelated baseline outcomes', async () => {
  const directory = tempDirectory();

  try {
    initSarsi(path.join(directory, 'sarsi'));
    const curator = new Curator(path.join(directory, 'curator-state.json'));
    const meta = new MetaN(path.join(directory, 'meta-state.json'), curator);
    const initialConfidence = getSarsiModel().confidence.p4;
    const first = record('baseline-unique-0');
    await meta.feedOutcome(first);
    await meta.feedOutcome(first);
    for (let index = 1; index < 7; index++) {
      await meta.feedOutcome(record(`baseline-unique-${index}`));
    }
    await meta.feedOutcome(record('baseline-unrelated', {
      taskType: 'creative',
      routingRuleId: 'p3',
      provider: 'openai',
    }));
    await curator.reviewInteraction(record('eligible-proposal'));
    assert.equal(getSarsiModel().confidence.p4, initialConfidence);
    await meta.runCycle();
    assert.equal(meta.getActiveCount(), 0);

    await meta.feedOutcome(record('baseline-unique-7'));
    await meta.runCycle();
    assert.equal(meta.getActiveCount(), 1);
  } finally {
    shutdownSarsi();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Meta^n learns only tool outcomes and the runner enforces SARSI timeouts', async () => {
  const directory = tempDirectory();
  const originalCwd = process.cwd();
  const previousTimeout = process.env.SYMBIOTE_TOOL_TIMEOUT_MS;

  try {
    process.chdir(directory);
    initSarsi(path.join(directory, '.symbiote'));
    delete process.env.SYMBIOTE_TOOL_TIMEOUT_MS;
    getSarsiModel().toolRules.find(rule => rule.id === 't1')!.timeoutMs = 25;
    const curator = new Curator(path.join(directory, 'curator-state.json'));
    const meta = new MetaN(path.join(directory, 'meta-state.json'), curator);
    for (let index = 0; index < 8; index++) {
      await meta.feedOutcome(record(`tool-baseline-${index}`, {
        good: true,
        toolResults: [{ tool: 'read', success: true }],
      }));
    }
    await curator.reviewInteraction(record('tool-proposal', {
      toolResults: [{ tool: 'read', success: false, error: 'ETIMEDOUT' }],
    }));
    await meta.runCycle();
    assert.equal(getSarsiModel().toolRules.find(rule => rule.id === 't1')?.timeoutMs, 38);

    let streamCount = 0;
    const provider: Provider = {
      name: 'timeout-test',
      async *stream(): AsyncGenerator<StreamEvent> {
        streamCount++;
        if (streamCount === 1) {
          yield { type: 'tool_use_start', id: 'read-call', name: 'read' };
          yield { type: 'tool_use_delta', id: 'read-call', input: '{}' };
          yield { type: 'tool_use_end', id: 'read-call' };
        } else {
          yield { type: 'text_delta', text: 'finished' };
        }
      },
    };
    const result = await runAgent([{ role: 'user', content: 'read a file' }], {
      provider,
      providerConfig: { model: 'mock' },
      toolRegistry: {
        toProviderFormat: () => [],
        list: () => [],
        execute: async () => new Promise(resolve => setTimeout(() => resolve('late result'), 100)),
      },
      maxIterations: 5,
    });
    assert.match(result.toolCalls[0]?.result ?? '', /timed out/);
    await feed(meta, 'tool-candidate-failed', false, {
      taskType: 'simple_qa',
      routingRuleId: 'p4',
      provider: 'groq',
      toolResults: [{ tool: 'read', success: false }],
    });
    assert.equal(meta.getHistory().at(-1)?.decision, 'rollback');
    assert.equal(getSarsiModel().toolRules.find(rule => rule.id === 't1')?.timeoutMs, 25);
    assert.equal(getSarsiModel().ruleHistory.find(entry => entry.ruleId === 't1')?.rollback, false);
  } finally {
    if (previousTimeout === undefined) delete process.env.SYMBIOTE_TOOL_TIMEOUT_MS;
    else process.env.SYMBIOTE_TOOL_TIMEOUT_MS = previousTimeout;
    shutdownSarsi();
    process.chdir(originalCwd);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
