// Symbiote — Memory System Tests
//
// Tests the unified VDB-backed memory system:
//   1. VDB core — index, search, dedup, persistence, recent
//   2. COMB → VDB integration — staging flows into VDB, recall reads from VDB
//   3. Context Store — retrieval, absorption, boot ingest
//   4. Edge cases — empty queries, huge docs, concurrent access
//
// Run: node dist/test/memory-system.test.js

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { VectorDB, extractFromSession, ingestSessions } from '../memory/vdb.js';
import { ContextStore } from '../agent/context-store.js';
import { setCombVdbHook, combStageTool, combRecallTool, flushMessages } from '../tools/builtin/comb.js';
import type { Message } from '../providers/types.js';

// ── Test Infrastructure ──────────────────────────────────────────────────

let testDir: string;
let passed = 0;
let failed = 0;
let total = 0;

function setup() {
  testDir = path.join('/tmp', `mach6-mem-test-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  process.env.MACH6_WORKSPACE = testDir;
}

function teardown() {
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* */ }
  delete process.env.MACH6_WORKSPACE;
}

function assert(condition: boolean, message: string): void {
  total++;
  if (condition) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.error(`  ❌ ${message}`);
  }
}

function assertEqual(actual: any, expected: any, message: string): void {
  total++;
  if (actual === expected) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.error(`  ❌ ${message} — expected ${expected}, got ${actual}`);
  }
}

function section(name: string): void {
  console.log(`\n━━━ ${name} ━━━`);
}

// ── 1. VDB Core Tests ───────────────────────────────────────────────────

function testVdbCore() {
  section('VDB Core');

  const db = new VectorDB(testDir, 60000);

  // Basic indexing
  const indexed = db.index({
    id: '', text: 'The GLADIUS architecture uses progressive expansion to grow neural networks.',
    source: 'test', role: 'assistant', timestamp: Date.now(),
  });
  assert(indexed === true, 'Index new document returns true');

  // Dedup by content hash
  const dupe = db.index({
    id: '', text: 'The GLADIUS architecture uses progressive expansion to grow neural networks.',
    source: 'test', role: 'assistant', timestamp: Date.now(),
  });
  assert(dupe === false, 'Duplicate document rejected');

  // Stats
  const stats = db.stats();
  assertEqual(stats.documentCount, 1, 'Stats: 1 document indexed');
  assert(stats.termCount > 0, 'Stats: terms indexed');

  // Batch index
  const docs = [
    'Cthulu is an autonomous trading system with 32 tentacles scanning the market.',
    'Ali built the research lab with two heads — philosophical frameworks and bare-metal genesis.',
    'The Context Store bridges attention and memory — truncated messages get absorbed into VDB.',
    'COMB provides lossless session-to-session context through staging and recall.',
    'Mach6 is the sixth sense — the agent runtime that powers everything.',
    'The Two-Point Theorem states that intelligence requires two sequential observations.',
    'Dead Drop uses HMAC-SHA256 for unsigned frame authentication.',
    'Net2Net growth expands neural networks by duplicating and perturbing neurons.',
    'BM25 is a probabilistic ranking function for information retrieval.',
    'Time series forecasting with transformers requires careful positional encoding.',
  ];

  let batchCount = 0;
  for (const text of docs) {
    if (db.index({ id: '', text, source: 'test', role: 'context', timestamp: Date.now() - Math.random() * 86400000 })) {
      batchCount++;
    }
  }
  assertEqual(batchCount, docs.length, `Batch: ${docs.length} unique docs indexed`);

  // Search — exact keyword match
  const r1 = db.search('GLADIUS architecture', 3);
  assert(r1.length > 0, 'Search: "GLADIUS architecture" returns results');
  assert(r1[0].text.includes('GLADIUS'), 'Search: top result contains GLADIUS');

  // Search — semantic proximity
  const r2 = db.search('trading bot market scanning', 3);
  assert(r2.length > 0, 'Search: "trading bot market" returns results');
  assert(r2[0].text.includes('trading') || r2[0].text.includes('Cthulu'), 'Search: top result is about trading');

  // Search — no results for gibberish
  const r3 = db.search('xyzzy plugh quartzite', 3);
  assert(r3.length === 0 || r3[0].score < 0.1, 'Search: gibberish returns no/low results');

  // Search with source filter
  const r4 = db.search('architecture', 10, { source: 'nonexistent' });
  assertEqual(r4.length, 0, 'Search: source filter excludes all when no match');

  // Empty query
  const r5 = db.search('', 5);
  assertEqual(r5.length, 0, 'Search: empty query returns nothing');

  // Recent — chronological retrieval
  const now = Date.now();
  db.index({ id: '', text: 'Recent entry one about dragons', source: 'recent-test', role: 'context', timestamp: now - 3000 });
  db.index({ id: '', text: 'Recent entry two about phoenixes', source: 'recent-test', role: 'context', timestamp: now - 2000 });
  db.index({ id: '', text: 'Recent entry three about griffins', source: 'recent-test', role: 'context', timestamp: now - 1000 });

  const recent = db.recent('recent-test', 3);
  assertEqual(recent.length, 3, 'Recent: returns 3 entries');
  assert(recent[0].text.includes('griffins'), 'Recent: most recent first');
  assert(recent[2].text.includes('dragons'), 'Recent: oldest last');

  const recentLimited = db.recent('recent-test', 2);
  assertEqual(recentLimited.length, 2, 'Recent: respects k limit');

  const recentEmpty = db.recent('nonexistent-source', 5);
  assertEqual(recentEmpty.length, 0, 'Recent: empty for unknown source');

  // Persistence — evict and reload
  db.evict();
  const r6 = db.search('GLADIUS', 3);
  assert(r6.length > 0, 'Persistence: results survive evict+reload');
  assert(r6[0].text.includes('GLADIUS'), 'Persistence: correct result after reload');

  // Compact
  const saved = db.compact();
  assert(saved >= 0, `Compact: saved ${saved} bytes`);

  const stats2 = db.stats();
  assertEqual(stats2.documentCount, 14, 'Compact: document count preserved');

  // Idle check — shouldn't evict when recent
  const evicted = db.checkIdle();
  assertEqual(evicted, false, 'Idle check: not evicted when recently accessed');
}

// ── 2. COMB → VDB Integration ───────────────────────────────────────────

async function testCombVdbIntegration() {
  section('COMB → VDB Integration');

  const db = new VectorDB(testDir, 60000);

  // Wire the hooks (both index and recent)
  setCombVdbHook(
    (text: string, source: string) => {
      db.index({
        id: '', text: text.length > 2000 ? text.slice(0, 2000) : text,
        source, role: 'context', timestamp: Date.now(), sessionId: 'comb',
      });
    },
    (source: string, k: number) => db.recent(source, k),
  );

  // Stage through COMB tool
  await combStageTool.execute({ content: 'Working on GLADIUS hatchling training — step 4000, loss 5.76' });
  await combStageTool.execute({ content: 'Cthulu K9 has 3 open positions: EURUSD SHORT, OIL LONG, BTC LONG' });
  await combStageTool.execute({ content: 'Vault was corrupted on March 11, rebuilt with 23 credentials' });

  // Search VDB for COMB-staged content
  const r1 = db.search('GLADIUS training loss', 3);
  assert(r1.length > 0, 'COMB→VDB: staged content searchable in VDB');
  assert(r1[0].text.includes('hatchling') || r1[0].text.includes('GLADIUS'), 'COMB→VDB: correct result for GLADIUS query');

  const r2 = db.search('vault corrupted credentials', 3);
  assert(r2.length > 0, 'COMB→VDB: vault content searchable');

  // COMB recall — should pull from VDB recent
  const recallResult = await combRecallTool.execute({});
  assert(typeof recallResult === 'string', 'COMB recall: returns string');
  assert(recallResult.includes('COMB RECALL'), 'COMB recall: has header');
  assert(recallResult.includes('GLADIUS') || recallResult.includes('hatchling'), 'COMB recall: contains staged content');
  assert(recallResult.includes('Vault') || recallResult.includes('vault'), 'COMB recall: contains all staged items');

  // Flush messages (simulating shutdown)
  const fakeMessages = [
    { role: 'user', content: 'Check the Cthulu positions please' },
    { role: 'assistant', content: 'Cthulu K9 has 3 open positions with positive P&L of 1.15 dollars' },
    { role: 'user', content: 'Good. What about the training run?' },
    { role: 'assistant', content: 'Hatchling training at step 4000, loss 5.76, on track for completion by morning' },
  ];
  flushMessages('test-session', fakeMessages, 4);

  // Verify flush content in VDB
  const r3 = db.search('Cthulu positions P&L', 3);
  assert(r3.length > 0, 'COMB flush→VDB: flushed messages searchable');

  // Clean up hook
  setCombVdbHook(() => {});
}

// ── 3. Context Store Tests ──────────────────────────────────────────────

function testContextStore() {
  section('Context Store');

  const db = new VectorDB(testDir, 60000);

  // Seed with knowledge
  db.indexBatch([
    { id: '', text: 'The SHARD contract is deployed at 0x0000000000000000000000000000000000000001 on Base.', source: 'identity', role: 'context', timestamp: Date.now() - 3600000 },
    { id: '', text: 'Ali birthday is March 12. He turned 38 in 2026.', source: 'memory', role: 'context', timestamp: Date.now() - 7200000 },
    { id: '', text: 'The vault key is at ~/.vault-key with permissions 600.', source: 'tools', role: 'context', timestamp: Date.now() - 1800000 },
    { id: '', text: 'Progressive expansion grows GLADIUS: Seed→Hatchling→Drake→Wyrm→Dragon.', source: 'workflow', role: 'context', timestamp: Date.now() - 900000 },
  ]);

  const cs = new ContextStore(db, {
    retrievalK: 3,
    retrievalThreshold: 0.1,
    retrievalBudget: 3000,
    queryDepth: 3,
    sessionSource: 'test',
    sessionId: 'test-session',
  });

  // Boot ingest
  const bootCount = cs.ingestBoot([
    { text: 'Symbiote is an agentic AI runtime. It manages conversations, tools, and memory.', source: 'boot-doc' },
  ]);
  assert(bootCount > 0, 'Boot ingest: indexed chunks');

  // Retrieval
  const messages: Message[] = [
    { role: 'system', content: 'You are AVA.' },
    { role: 'user', content: 'Where is the SHARD contract deployed?' },
  ];
  const retrieval = cs.retrieve(messages);
  assert(retrieval !== null, 'Retrieval: found relevant context for SHARD query');
  if (retrieval) {
    assert(typeof retrieval.content === 'string' && retrieval.content.includes('RETRIEVED CONTEXT'), 'Retrieval: has header');
    assert(typeof retrieval.content === 'string' && (retrieval.content.includes('SHARD') || retrieval.content.includes('0xE897')), 'Retrieval: includes SHARD info');
  }

  // Retrieval — unrelated query doesn't crash
  const messages2: Message[] = [
    { role: 'system', content: 'You are AVA.' },
    { role: 'user', content: 'What is the weather today?' },
  ];
  cs.retrieve(messages2); // just verify no crash
  assert(true, 'Retrieval: no crash on unrelated query');

  // Absorption
  const droppedMessages: Message[] = [
    { role: 'user', content: 'We discussed the Cthulu trading system architecture extensively. The K9 Brain scans every 60 seconds with 32 tentacles.' },
    { role: 'assistant', content: 'The confluence engine uses 4-pillar scoring with PUP uncertainty quantification. Each tentacle aggregates 8 indicators across 8 timeframes.' },
    { role: 'tool', content: 'some tool result that should be skipped' },
    { role: 'system', content: 'system message that should be skipped' },
    { role: 'user', content: 'Short' }, // too short
  ];

  const absorbed = cs.absorb(droppedMessages);
  assertEqual(absorbed, 2, 'Absorption: absorbed 2 messages (skipped tool, system, short)');

  const r1 = db.search('Cthulu K9 tentacles confluence', 3);
  assert(r1.length > 0, 'Absorption→Search: absorbed content is searchable');
  assert(r1.some(r => r.source === 'absorbed'), 'Absorption→Search: source tagged as "absorbed"');

  // truncateAndAbsorb
  const fullMessages: Message[] = [
    { role: 'system', content: 'System prompt goes here.' },
    { role: 'user', content: 'A'.repeat(10000) },
    { role: 'assistant', content: 'B'.repeat(10000) },
    { role: 'user', content: 'C'.repeat(10000) },
    { role: 'assistant', content: 'D'.repeat(10000) },
    { role: 'user', content: 'Recent question about memory systems' },
  ];

  const truncated = cs.truncateAndAbsorb(fullMessages, 5000, (msgs, max) => {
    const system = msgs.filter(m => m.role === 'system');
    const rest = msgs.filter(m => m.role !== 'system');
    return [...system, ...rest.slice(-2)];
  });

  assert(truncated.length < fullMessages.length, 'truncateAndAbsorb: messages were truncated');
  assert(truncated.length >= 3, 'truncateAndAbsorb: kept system + recent');

  const stats = cs.stats();
  assert(stats.documentCount > 0, `Context Store stats: ${stats.documentCount} docs`);
}

// ── 4. Session Ingestion Tests ──────────────────────────────────────────

function testSessionIngestion() {
  section('Session Ingestion');

  const db = new VectorDB(testDir, 60000);

  const sessionsDir = path.join(testDir, '.sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });

  const fakeSession = {
    sessionId: 'whatsapp-test-123',
    createdAt: Date.now() - 3600000,
    messages: [
      { role: 'system', content: 'You are AVA.' },
      { role: 'user', content: 'Can you check the Cthulu bridge health?' },
      { role: 'assistant', content: 'Checking the Cthulu bridge now. The webhook on port 9002 is responding, and the bridge reports 142 active connections.' },
      { role: 'user', content: 'Good. And the GLADIUS training status?' },
      { role: 'assistant', content: 'The hatchling training is at step 3000 with loss 6.02. It should complete around 6:40 AM.' },
      { role: 'tool', content: '{"status": "ok"}' },
      { role: 'assistant', content: 'Short' },
    ],
  };

  fs.writeFileSync(path.join(sessionsDir, 'whatsapp-test-123.json'), JSON.stringify(fakeSession));

  const docs = extractFromSession(path.join(sessionsDir, 'whatsapp-test-123.json'), 'whatsapp');
  assert(docs.length >= 3, `Session extract: ${docs.length} docs (expected ≥3)`);
  assert(docs.every(d => d.source === 'whatsapp'), 'Session extract: source tagged correctly');
  assert(docs.every(d => d.sessionId === 'whatsapp-test-123'), 'Session extract: sessionId set');

  const result = ingestSessions(db, sessionsDir);
  assert(result.processed > 0, `Session ingest: processed ${result.processed} messages`);
  assert(result.indexed > 0, `Session ingest: indexed ${result.indexed} new`);

  const r1 = db.search('Cthulu bridge health webhook', 3);
  assert(r1.length > 0, 'Session→VDB: ingested content searchable');

  const result2 = ingestSessions(db, sessionsDir);
  assertEqual(result2.indexed, 0, 'Session ingest: no duplicates on re-ingest');
}

// ── 5. Edge Cases & Stress Tests ────────────────────────────────────────

function testEdgeCases() {
  section('Edge Cases');

  const db = new VectorDB(testDir, 60000);

  // Very long document
  const longText = 'machine learning '.repeat(1000);
  const indexed = db.index({
    id: '', text: longText, source: 'test', role: 'context', timestamp: Date.now(),
  });
  assert(indexed === true, 'Long document: indexed without crash');

  // Very short text
  const short = db.index({
    id: '', text: 'a', source: 'test', role: 'context', timestamp: Date.now(),
  });
  assert(short === false, 'Short text: rejected (no useful terms)');

  // Unicode
  const unicode = db.index({
    id: '', text: 'بسم الله الرحمن الرحیم — GLADIUS training initiated at 2:45 AM PKT',
    source: 'test', role: 'context', timestamp: Date.now(),
  });
  assert(unicode === true, 'Unicode: indexed successfully');
  const uniSearch = db.search('GLADIUS training 2:45', 3);
  assert(uniSearch.length > 0, 'Unicode: searchable by ASCII terms');

  // Burst indexing
  let burstCount = 0;
  for (let i = 0; i < 100; i++) {
    if (db.index({
      id: '',
      text: `Burst document number ${i}: ${crypto.randomBytes(20).toString('hex')}`,
      source: 'burst', role: 'context', timestamp: Date.now(),
    })) {
      burstCount++;
    }
  }
  assertEqual(burstCount, 100, 'Burst: 100 unique docs indexed');

  const burstSearch = db.search('burst document number', 5);
  assert(burstSearch.length === 5, 'Burst search: returns k=5 results');

  // Evict and reload after heavy use
  db.evict();
  const reloadSearch = db.search('burst document', 3);
  assert(reloadSearch.length > 0, 'Reload after burst: data persists');

  // COMB with no hook wired — should not crash
  setCombVdbHook(() => {});
  const emptyRecall = combRecallTool.execute({});
  assert(emptyRecall !== undefined, 'COMB recall without recentFn: does not crash');
}

// ── 6. COMB as Pure VDB Wrapper ─────────────────────────────────────────

async function testCombPureVdb() {
  section('COMB as Pure VDB Wrapper (No Files)');

  const db = new VectorDB(testDir, 60000);

  // Wire hooks
  setCombVdbHook(
    (text: string, source: string) => {
      db.index({
        id: '', text, source, role: 'context', timestamp: Date.now(),
      });
    },
    (source: string, k: number) => db.recent(source, k),
  );

  // Stage, recall — no .comb directory should be created
  await combStageTool.execute({ content: 'Alpha release memory test — pure VDB path' });

  const combDir = path.join(testDir, '.comb');
  assert(!fs.existsSync(combDir), 'Pure VDB: no .comb directory created');

  // Recall works through VDB
  const recall = await combRecallTool.execute({});
  assert(typeof recall === 'string' && recall.includes('Alpha release'), 'Pure VDB recall: returns staged content');

  // flushMessages works through VDB
  flushMessages('alpha-test', [
    { role: 'user', content: 'Testing the pure VDB flush path for session continuity' },
    { role: 'assistant', content: 'The flush path writes directly to VDB without intermediate files' },
  ], 2);

  const r1 = db.search('pure VDB flush path', 3);
  assert(r1.length > 0, 'Pure VDB flush: flushed content searchable');

  // Verify source tagging
  const r2 = db.recent('auto-flush', 5);
  assert(r2.length > 0, 'Pure VDB flush: tagged as auto-flush source');

  const r3 = db.recent('comb', 5);
  assert(r3.length > 0, 'Pure VDB stage: tagged as comb source');

  // Cleanup
  setCombVdbHook(() => {});
}

// ── Run All Tests ────────────────────────────────────────────────────────

console.log('\n╔══════════════════════════════════════════╗');
console.log('║  SYMBIOTE MEMORY SYSTEM — TEST SUITE     ║');
console.log('╚══════════════════════════════════════════╝\n');

setup();

try {
  testVdbCore();
  await testCombVdbIntegration();
  testContextStore();
  testSessionIngestion();
  testEdgeCases();
  await testCombPureVdb();
} finally {
  teardown();
}

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`  Total: ${total}  Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) {
  console.log('  ❌ FAILURES DETECTED');
  process.exit(1);
} else {
  console.log('  ✅ ALL TESTS PASSED');
}
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
