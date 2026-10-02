import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextStore } from '../agent/context-store.js';
import { importMemoGraphSnapshots } from '../memory/memograph.js';
import { VectorDB } from '../memory/vdb.js';

test('Memograph import preserves shard topology, scopes, and permission boundaries', () => {
  const root = mkdtempSync(join(tmpdir(), 'symbiote-memograph-'));
  const graphDir = join(root, 'graphs');
  mkdirSync(graphDir, { recursive: true });

  try {
    writeFileSync(join(graphDir, 'project-alpha.json'), JSON.stringify({
      _memograph_schema: 2,
      nodes: {
        parent: {
          shard_hash: 'parent-hash', content: { decision: 'Tenant scoped storage architecture' },
          owner: 'agent', scope: 'project:alpha', domain: 'project', parent_hash: null,
          permissions: ['agent'], timestamp: 1_790_000_000, version: 1, content_type: 'DECISION',
        },
        child: {
          shard_hash: 'child-hash', content: { rationale: 'Separate tenant memory topology' },
          owner: 'agent', scope: 'project:alpha', domain: 'project', parent_hash: 'parent-hash',
          permissions: ['agent'], timestamp: 1_790_000_001, version: 2, content_type: 'EPISTEMIC',
        },
        restricted: {
          shard_hash: 'restricted-hash', content: { note: 'Secret cobalt credential memory' },
          owner: 'admin', scope: 'enterprise:private', domain: 'enterprise', parent_hash: null,
          permissions: ['admin'], timestamp: 1_790_000_002, version: 1, content_type: 'POLICY',
        },
      },
      edges: { 'parent-hash': ['child-hash'] },
    }));
    writeFileSync(join(graphDir, 'damaged.json'), '{broken');

    const db = new VectorDB(join(root, 'workspace'));
    const imported = importMemoGraphSnapshots(db, graphDir);
    assert.equal(imported.files, 1);
    assert.equal(imported.shards, 3);
    assert.equal(imported.indexed, 3);
    assert.equal(imported.failures, 1);

    const parentId = 'memograph:project-alpha:parent-hash';
    const parent = db.getDocument(parentId);
    assert.equal(parent?.namespace, 'memograph:project-alpha:project:project:alpha');
    assert.equal(parent?.metadata?.memoryShardHash, 'parent-hash');
    assert.deepEqual(JSON.parse(parent?.metadata?.memoryRelations ?? '[]'), [
      'memograph:project-alpha:child-hash',
    ]);

    assert.equal(db.index({
      id: 'duplicate-live', text: 'same atomic memory text', source: 'manual', role: 'memory',
      timestamp: 1_790_000_010_000, namespace: 'memograph:live:project:alpha',
    }), true);
    assert.equal(db.index({
      id: 'duplicate-enterprise', text: 'same atomic memory text', source: 'manual', role: 'memory',
      timestamp: 1_790_000_010_000, namespace: 'memograph:enterprise:org:alpha',
    }), true);
    db.compact();
    const reopened = new VectorDB(join(root, 'workspace'));
    assert.ok(reopened.getDocument(parentId)?.metadata?.memoryRelations);
    assert.equal(reopened.search('same atomic memory text', 5, { namespace: 'memograph:live:project:alpha' }).length, 1);
    assert.equal(reopened.search('same atomic memory text', 5, { namespace: 'memograph:enterprise:org:alpha' }).length, 1);

    assert.equal(importMemoGraphSnapshots(db, graphDir).indexed, 0);

    const contextStore = new ContextStore(reopened, {
      retrievalK: 5,
      retrievalThreshold: 0,
      retrievalBudget: 4000,
      sessionId: 'test-session',
      graphNeighbors: 2,
    });
    const context = contextStore.retrieve([
      { role: 'user', content: 'Explain the tenant scoped storage architecture and topology decision.' },
    ]);
    assert.ok(context && typeof context.content === 'string');
    assert.match(context.content as string, /parent-has/);
    assert.match(context.content as string, /child-hash/);
    assert.doesNotMatch(context.content as string, /Secret cobalt credential memory/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});