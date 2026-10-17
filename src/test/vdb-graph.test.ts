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

test('similarity graph downweights corpus-wide terms and favors distinctive shared vocabulary', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-vdb-idf-'));
  try {
    const db = new VectorDB(workspace);
    db.indexBatch([
      { id: 'a', text: 'common system update project semantic vector retrieval engine', source: 'docs', role: 'context', timestamp: 1 },
      { id: 'b', text: 'common system update project semantic vector retrieval engine index', source: 'docs', role: 'context', timestamp: 2 },
      { id: 'c', text: 'common system update project gardening photosynthesis soil', source: 'docs', role: 'context', timestamp: 3 },
      { id: 'd', text: 'common system update project astronomy telescope nebula', source: 'docs', role: 'context', timestamp: 4 },
    ]);

    const edges = db.similarityEdges(3, 0.01);
    const score = (left: string, right: string) => edges.find(edge =>
      (edge.source === left && edge.target === right) || (edge.source === right && edge.target === left),
    )?.similarity ?? 0;
    assert.ok(score('a', 'b') > score('a', 'c'));
    assert.ok(score('a', 'b') > score('a', 'c'));
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('namespace synchronization refreshes changed project documents and removes stale files', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-vdb-namespace-'));
  try {
    const db = new VectorDB(workspace);
    const overview = {
      id: 'project:one:overview',
      text: 'Project scope includes a semantic memory index.',
      source: 'project',
      role: 'context',
      timestamp: 1,
      namespace: 'project:one',
    };
    const oldFile = {
      id: 'project:one:file:old.md',
      text: 'The legacy project file is obsolete.',
      source: 'project-file',
      role: 'context',
      timestamp: 2,
      namespace: 'project:one',
    };
    const unrelated = {
      id: 'project:two:overview',
      text: 'Another project tracks deployment health.',
      source: 'project',
      role: 'context',
      timestamp: 3,
      namespace: 'project:two',
    };
    db.syncNamespace('project:one', [overview, oldFile]);
    db.syncNamespace('project:two', [unrelated]);
    assert.deepEqual(db.syncNamespace('project:one', [overview, {
      ...oldFile,
      id: 'project:one:file:new.md',
      text: 'The current project file describes semantic retrieval.',
      timestamp: 4,
    }]), { added: 1, removed: 1, unchanged: false });
    assert.deepEqual(db.syncNamespace('project:one', [overview, {
      ...oldFile,
      id: 'project:one:file:new.md',
      text: 'The current project file describes semantic retrieval.',
      timestamp: 4,
    }]), { added: 0, removed: 0, unchanged: true });

    const documents = db.listDocuments();
    assert.equal(documents.length, 3);
    assert.ok(!documents.some(document => document.id === oldFile.id));
    assert.ok(documents.some(document => document.id === unrelated.id));
    assert.ok(new VectorDB(workspace).listDocuments().some(document => document.id === 'project:one:file:new.md'));
    assert.throws(() => db.syncNamespace('project:one', [{ ...overview, namespace: 'project:other' }]), /belong to the requested namespace/);
    assert.throws(() => db.syncNamespace('project:one', [overview, overview]), /Duplicate vector document ID/);
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
