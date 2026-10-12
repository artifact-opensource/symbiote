import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Curator, type InteractionRecord } from '../curator/curator.js';
import { MetaN } from '../meta/meta.js';
import { TodoManager } from '../agent/todo.js';
import { combStageTool } from '../tools/builtin/comb.js';

function tempDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-memory-state-'));
}

function interaction(toolResults?: InteractionRecord['toolResults']): InteractionRecord {
  return {
    id: 'persist-test',
    timestamp: new Date().toISOString(),
    taskType: 'unmatched-task-type',
    provider: 'test',
    model: 'test',
    tokensUsed: 1,
    latencyMs: 1,
    toolSuccess: true,
    userSatisfied: false,
    toolCallCount: toolResults?.length ?? 0,
    delivered: true,
    channel: 'test',
    routingWasOptimal: false,
    toolResults,
  };
}

test('Curator proposals and failure evidence survive reconstruction', async () => {
  const directory = tempDirectory();
  const statePath = path.join(directory, 'curator-state.json');

  try {
    const curator = new Curator(statePath);
    await curator.reviewInteraction(interaction([{ tool: 'flaky_tool', success: false, error: 'ETIMEDOUT' }]));

    const restored = new Curator(statePath);
    const stats = restored.getStats();
    assert.equal(stats.reviewCount, 1);
    assert.equal(stats.pendingCount, 1);
    assert.equal(stats.trackedTools, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Meta^n iteration state survives reconstruction', async () => {
  const directory = tempDirectory();
  const statePath = path.join(directory, 'meta-state.json');

  try {
    const meta = new MetaN(statePath, new Curator(path.join(directory, 'curator-state.json')));
    await meta.runCycle();

    const restored = new MetaN(statePath, new Curator(path.join(directory, 'curator-state.json')));
    assert.equal(restored.getStats().iterations, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('corrupt todo state is surfaced instead of replaced with an empty checklist', () => {
  const directory = tempDirectory();
  const statePath = path.join(directory, 'todos.json');

  try {
    fs.writeFileSync(statePath, '{not-json', 'utf8');
    const manager = new TodoManager({ filePath: statePath });
    assert.throws(() => manager.list(), /Failed to read todo state/);
    assert.equal(fs.readFileSync(statePath, 'utf8'), '{not-json');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('COMB reports staging failure when no durable memory backend is wired', async () => {
  const result = await combStageTool.execute({ content: 'A durable test memory entry.' });
  assert.equal(typeof result, 'string');
  assert.match(result as string, /Memory backend is not initialized/);
});
