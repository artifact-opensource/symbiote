import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { VectorDB, ingestSessions } from '../memory/vdb.js';

test('similarity graph returns accurate neighbors and remains stable after reload', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-vdb-graph-'));
  try {
    const db = new VectorDB(workspace);
    db.indexBatch([
      { id: 'doc-a', text: 'Maple forests contain red leaves, woodland paths, and quiet streams.', source: 'docs', role: 'context', timestamp: 1 },
      { id: 'doc-b', text: 'Woodland paths wind beneath maple trees beside quiet streams.', source: 'docs', role: 'context', timestamp: 2 },
      { id: 'doc-c', text: 'The HTTP server listens on a configurable network port.', source: 'docs', role: 'context', timestamp: 3 },
    ]);

    const edge = db.similarityEdges(2, 0.01).find(item =>
      (item.source === 'doc-a' && item.target === 'doc-b')
      || (item.source === 'doc-b' && item.target === 'doc-a'),
    );
    assert.ok(edge);
    assert.ok(edge.similarity > 0.2);
    assert.equal(db.listDocuments().length, 3);

    const reopened = new VectorDB(workspace);
    const reloadedEdge = reopened.similarityEdges(2, 0.01).find(item =>
      item.source === edge.source && item.target === edge.target,
    );
    assert.equal(reloadedEdge?.similarity, edge.similarity);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('session ingestion includes nested archives and deduplicates stable session turns', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-session-ingest-'));
  try {
    const sessions = path.join(workspace, '.session');
    const archive = path.join(sessions, 'archive', 'nested');
    fs.mkdirSync(archive, { recursive: true });
    const messages = [
      { role: 'user', content: 'Please remember that the northern observatory tracks aurora activity.' },
      { role: 'assistant', content: 'The observatory records aurora intensity every evening.' },
    ];
    fs.writeFileSync(path.join(archive, 'web-thread.json'), JSON.stringify({
      id: 'web-thread',
      createdAt: 1000,
      messages,
    }));

    const db = new VectorDB(workspace);
    const first = ingestSessions(db, sessions, 'session');
    assert.deepEqual(first, { processed: 2, indexed: 2 });
    assert.equal(db.listDocuments().length, 2);
    assert.ok(db.listDocuments().every(document => document.source === 'webchat'));
    assert.ok(db.listDocuments().every(document => document.namespace === 'session:web-thread'));

    const second = ingestSessions(db, sessions, 'session');
    assert.deepEqual(second, { processed: 2, indexed: 0 });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
