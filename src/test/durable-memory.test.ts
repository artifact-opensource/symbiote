import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DurableMemory } from '../memory/durable-memory.js';
import { importMemoGraphSnapshots } from '../memory/memograph.js';
import { VectorDB } from '../memory/vdb.js';
import { combRecallTool, memoryOffloadTool, setCombVdbHook, setMemoryOffloadHook } from '../tools/builtin/comb.js';

test('durable offload writes one JSONL record, a verified Memograph chain, and searchable VDB documents', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-durable-memory-'));
  const workspace = path.join(root, 'workspace');
  const archive = path.join(workspace, '.symbiote', 'memory.jsonl');
  const graphDirectory = path.join(root, 'memograph');

  try {
    const database = new VectorDB(workspace);
    const memory = new DurableMemory(database, archive, graphDirectory);
    const summary = 'The agent should use one concise, provenance-linked record for each durable task decision; café notes remain verifiable.';
    setCombVdbHook(
      (text, source) => database.index({ id: '', text, source, role: 'context', timestamp: Date.now() }),
      (source, count) => database.recent(source, count),
      (query, count, namespace) => database.search(query, count, { namespace }),
    );
    setMemoryOffloadHook((summary, sessionId, source) => memory.offload(summary, sessionId, source));
    const toolResult = await memoryOffloadTool.execute({
      summary,
      sessionId: 'task-1',
    });
    assert.match(String(toolResult), /durably stored in JSONL, VDB, and Memograph/);

    const first = memory.offload(summary, 'task-1');
    const duplicate = memory.offload(summary, 'task-1');
    const second = memory.offload('COMB offloads durable summaries to the cold archive and Memograph graph.', 'task-1');

    assert.equal(first.duplicate, true);
    assert.equal(duplicate.duplicate, true);
    assert.equal(second.duplicate, false);
    assert.equal(fs.readFileSync(archive, 'utf8').trim().split(/\r?\n/).length, 2);
    const recalled = await combRecallTool.execute({ query: 'provenance-linked durable task decision' });
    assert.match(String(recalled), /provenance-linked record/);
    assert.match(fs.readFileSync(archive, 'utf8'), /café/);

    const snapshot = JSON.parse(fs.readFileSync(path.join(graphDirectory, 'symbiote_live.json'), 'utf8')) as {
      nodes: Record<string, { shard_hash: string; parent_hash: string | null }>;
      edges: Record<string, string[]>;
    };
    assert.equal(Object.keys(snapshot.nodes).length, 2);
    assert.equal(snapshot.nodes[second.shardHash].parent_hash, first.shardHash);
    assert.deepEqual(snapshot.edges[first.shardHash], [second.shardHash]);

    const importedDb = new VectorDB(path.join(root, 'imported-workspace'));
    const imported = importMemoGraphSnapshots(importedDb, graphDirectory);
    assert.equal(imported.indexed, 2);
    assert.equal(imported.hashVerified, 2);
    assert.equal(imported.hashMismatches, 0);
    assert.deepEqual(
      (({ archiveRecords, graphShards, verifiedShards }) => ({ archiveRecords, graphShards, verifiedShards }))(memory.stats()),
      { archiveRecords: 2, graphShards: 2, verifiedShards: 2 },
    );
    const search = importedDb.search('provenance linked durable task decision', 5);
    assert.ok(search.some(result => result.id === `memograph:symbiote_live:${first.shardHash}`));
    assert.equal(importedDb.getDocument(`memograph:symbiote_live:${second.shardHash}`)?.metadata?.memoryVerified, 'true');

    const reopened = new DurableMemory(new VectorDB(workspace), archive, graphDirectory);
    assert.equal(reopened.offload(summary, 'task-1').duplicate, true);
    assert.equal(fs.readFileSync(archive, 'utf8').trim().split(/\r?\n/).length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('durable offload rejects empty or oversized memories before writing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-durable-memory-invalid-'));
  try {
    const archive = path.join(root, 'memory.jsonl');
    const memory = new DurableMemory(new VectorDB(path.join(root, 'workspace')), archive, path.join(root, 'graph'));
    assert.throws(() => memory.offload('   '), /non-empty/);
    assert.throws(() => memory.offload('x'.repeat(20_001)), /20,000 characters or fewer/);
    assert.equal(fs.existsSync(archive), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
