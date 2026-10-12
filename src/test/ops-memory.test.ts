import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ContextStore } from '../agent/context-store.js';
import { OpsMemory, getOpsMemory, resetOpsMemoryForTests } from '../memory/ops-memory.js';
import { VectorDB } from '../memory/vdb.js';

function makeDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-ops-memory-'));
}

test('Ops Memory persists bounded metadata, not command arguments or tool output', () => {
  const directory = makeDirectory();
  const statePath = path.join(directory, 'ops-memory.json');
  const secret = 'private-token-value';

  try {
    const memory = new OpsMemory(statePath, directory);
    const calls = [
      {
        name: 'exec',
        input: { command: `Get-Service -Name Symbiote; $token="${secret}"` },
        result: 'Service status: Running',
      },
      {
        name: 'read',
        input: { path: `C:\\private\\${secret}.txt` },
        result: `File contents include ${secret}`,
      },
      { name: 'unknown_tool', input: { value: secret }, result: 'done' },
    ];
    const recorded = memory.recordToolOutcomes('interaction-1', calls);

    assert.equal(recorded, 2);
    const diskState = fs.readFileSync(statePath, 'utf8');
    assert.doesNotMatch(diskState, new RegExp(secret));
    assert.doesNotMatch(diskState, /Service status: Running|File contents include/);

    const restored = new OpsMemory(statePath, directory);
    const recalled = restored.formatRelevant('Is the Symbiote service running?');
    assert.match(recalled ?? '', /service\/exec: succeeded/);
    assert.match(recalled ?? '', /historical execution evidence, not live status/);
    assert.match(recalled ?? '', /Verify volatile state now/);
    assert.doesNotMatch(recalled ?? '', /Running/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Ops Memory deduplicates a completed interaction and ignores expired evidence', () => {
  const directory = makeDirectory();
  const statePath = path.join(directory, 'ops-memory.json');

  try {
    const memory = new OpsMemory(statePath, directory);
    const call = { name: 'process_list', input: {}, result: 'process list returned' };
    assert.equal(memory.recordToolOutcomes('same-interaction', [call]), 1);
    assert.equal(memory.recordToolOutcomes('same-interaction', [call]), 0);

    const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
      observations: Array<{ expiresAt: string }>;
    };
    state.observations[0].expiresAt = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(statePath, JSON.stringify(state), 'utf8');
    assert.equal(memory.formatRelevant('Is a process running?'), null);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Ops Memory surfaces corrupt state and scopes retrieval to its workspace', () => {
  const directory = makeDirectory();
  const statePath = path.join(directory, 'ops-memory.json');

  try {
    const memory = new OpsMemory(statePath, directory);
    memory.recordToolOutcomes('interaction', [{ name: 'exec', input: { command: 'npm test' }, result: 'passed' }]);
    assert.equal(new OpsMemory(statePath, path.join(directory, 'other-workspace')).formatRelevant('Did tests pass?'), null);

    fs.writeFileSync(statePath, '{invalid', 'utf8');
    assert.throws(() => memory.formatRelevant('What is the current memory status?'), /Failed to load Ops Memory/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Context Store injects ops evidence only for relevant current user queries', () => {
  const directory = makeDirectory();
  const oldWorkspace = process.env.SYMBIOTE_WORKSPACE;
  const oldToggle = process.env.SYMBIOTE_OPS_MEMORY;

  try {
    process.env.SYMBIOTE_WORKSPACE = directory;
    delete process.env.SYMBIOTE_OPS_MEMORY;
    resetOpsMemoryForTests();
    const opsMemory = getOpsMemory();
    assert.ok(opsMemory);
    opsMemory.recordToolOutcomes('context-interaction', [
      { name: 'exec', input: { command: 'Get-Service -Name Symbiote' }, result: 'service probe completed' },
    ]);

    const context = new ContextStore(new VectorDB(directory));
    const result = context.retrieve([{ role: 'user', content: 'Is the Symbiote service running now?' }]);
    assert.match(String(result?.content), /historical execution evidence/);
    assert.equal(context.retrieve([{ role: 'user', content: 'Hello there!' }]), null);
    assert.equal(context.retrieve([
      { role: 'user', content: 'Is the Symbiote service running now?' },
      { role: 'user', content: 'Hello there!' },
    ]), null);

    process.env.SYMBIOTE_OPS_MEMORY = '0';
    assert.equal(context.retrieve([{ role: 'user', content: 'Is the Symbiote service running now?' }]), null);
  } finally {
    if (oldWorkspace === undefined) delete process.env.SYMBIOTE_WORKSPACE;
    else process.env.SYMBIOTE_WORKSPACE = oldWorkspace;
    if (oldToggle === undefined) delete process.env.SYMBIOTE_OPS_MEMORY;
    else process.env.SYMBIOTE_OPS_MEMORY = oldToggle;
    resetOpsMemoryForTests();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
