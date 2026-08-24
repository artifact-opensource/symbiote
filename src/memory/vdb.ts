// Symbiote — Embedded Vector Database (VDB)
//
// Purpose-built persistent memory for Symbiote agents.
// Zero external dependencies. Pure TypeScript. File-backed.
// "So light it doesn't even exist."
//
// Architecture:
//   BM25 keyword index + TF-IDF sparse vectors + cosine similarity
//   Hybrid search (BM25 score * 0.4 + TF-IDF score * 0.6)
//   JSONL storage — append-only, compact on demand
//   Memory-mapped on first query, evicted after idle timeout
//
// What gets indexed:
//   - WhatsApp conversations (user <-> agent turns)
//   - Discord conversations
//   - COMB staged memories
//   - Any text the agent wants to remember
//
// What does NOT get indexed:
//   - Tool calls/results (noise)
//   - System prompts (already in context)
//   - Binary/image content

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ── Types ────────────────────────────────────────────────────────────────

export interface VDBDocument {
  id: string;
  text: string;
  source: string;        // "whatsapp", "discord", "comb", "manual"
  role: string;          // "user", "assistant", "context"
  timestamp: number;     // epoch ms
  sessionId?: string;
  metadata?: Record<string, string>;
}

interface StoredDocument extends VDBDocument {
  terms: string[];       // pre-tokenized for BM25
  tfidf: number[];       // sparse TF-IDF vector (indexed by global term position)
}

interface BM25Index {
  postings: Map<string, Map<string, number>>;  // term -> { docId -> tf }
  docLengths: Map<string, number>;
  avgDl: number;
  N: number;
}

export interface SearchResult {
  id: string;
  text: string;
  source: string;
  role: string;
  timestamp: number;
  score: number;
  sessionId?: string;
}

export interface VDBStats {
  documentCount: number;
  termCount: number;
  diskBytes: number;
  lastIndexed: number;
  sources: Record<string, number>;
}

// ── Graph Types ──────────────────────────────────────────────────────────

export interface GraphNode {
  id: string;
  label: string;
  source: string;
  sessionId?: string;
  timestamp: number;
  cluster: number;
  connections: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  weight: number;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  clusters: number;
  generated: number;
}

// ── Tokenizer (lightweight, no deps) ─────────────────────────────────────

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'and', 'but', 'or',
  'not', 'no', 'nor', 'so', 'yet', 'both', 'either', 'neither', 'each',
  'every', 'all', 'any', 'few', 'more', 'most', 'other', 'some', 'such',
  'than', 'too', 'very', 'just', 'also', 'now', 'then', 'here', 'there',
  'when', 'where', 'why', 'how', 'what', 'which', 'who', 'whom', 'this',
  'that', 'these', 'those', 'it', 'its', 'i', 'me', 'my', 'we', 'our',
  'you', 'your', 'he', 'him', 'his', 'she', 'her', 'they', 'them', 'their',
  'if', 'up', 'out', 'about', 'over', 'down', 'only', 'own', 'same',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s\-_.@]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && !STOP_WORDS.has(t));
}

function makeDocId(text: string, timestamp: number): string {
  return crypto.createHash('md5').update(`${timestamp}:${text.slice(0, 200)}`).digest('hex').slice(0, 12);
}

// ── VDB Engine ───────────────────────────────────────────────────────────

export class VectorDB {
  private dir: string;
  private docsFile: string;
  private indexFile: string;

  // In-memory state (lazy-loaded)
  private docs: Map<string, StoredDocument> | null = null;
  private bm25: BM25Index | null = null;
  private globalTerms: Map<string, number> | null = null;
  private dirty = false;
  private lastAccess = 0;
  private idleTimeout: number;
  private seenHashes: Set<string> = new Set();

  constructor(baseDir: string, idleTimeoutMs = 5 * 60 * 1000) {
    this.dir = path.join(baseDir, '.vdb');
    this.docsFile = path.join(this.dir, 'documents.jsonl');
    this.indexFile = path.join(this.dir, 'index.json');
    this.idleTimeout = idleTimeoutMs;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /** Index a document. Deduplicates by content hash. */
  index(doc: VDBDocument): boolean {
    this.ensureLoaded();

    const hash = crypto.createHash('md5').update(doc.text).digest('hex');
    if (this.seenHashes.has(hash)) return false;
    this.seenHashes.add(hash);

    const id = doc.id || makeDocId(doc.text, doc.timestamp);
    if (this.docs!.has(id)) return false;

    const terms = tokenize(doc.text);
    if (terms.length === 0) return false;

    // Register new terms
    for (const term of terms) {
      if (!this.globalTerms!.has(term)) {
        this.globalTerms!.set(term, this.globalTerms!.size);
      }
    }

    // Compute TF vector
    const tf = new Map<string, number>();
    for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);

    const tfidf: number[] = [];
    for (const [term, count] of tf) {
      const termIdx = this.globalTerms!.get(term)!;
      tfidf[termIdx] = count / terms.length;
    }

    const stored: StoredDocument = { ...doc, id, terms, tfidf };
    this.docs!.set(id, stored);

    // Update BM25
    this.bm25!.N++;
    this.bm25!.docLengths.set(id, terms.length);
    for (const [term, count] of tf) {
      if (!this.bm25!.postings.has(term)) this.bm25!.postings.set(term, new Map());
      this.bm25!.postings.get(term)!.set(id, count);
    }

    let totalLen = 0;
    for (const len of this.bm25!.docLengths.values()) totalLen += len;
    this.bm25!.avgDl = totalLen / this.bm25!.N;

    this.dirty = true;
    this.lastAccess = Date.now();
    this.appendDoc(stored);
    return true;
  }

  /** Batch index. Returns count of new documents. */
  indexBatch(docs: VDBDocument[]): number {
    let added = 0;
    for (const doc of docs) { if (this.index(doc)) added++; }
    if (this.dirty) this.saveIndex();
    return added;
  }

  /** Hybrid search: BM25 + TF-IDF cosine. */
  search(query: string, k = 5, filter?: { source?: string; role?: string; minTimestamp?: number }): SearchResult[] {
    this.ensureLoaded();
    this.lastAccess = Date.now();

    const queryTerms = tokenize(query);
    if (queryTerms.length === 0) return [];

    const bm25Scores = this.bm25Search(queryTerms);
    const tfidfScores = this.tfidfSearch(queryTerms);

    const combined = new Map<string, number>();
    const allIds = new Set([...bm25Scores.keys(), ...tfidfScores.keys()]);
    const bm25Max = Math.max(1e-10, ...bm25Scores.values());
    const tfidfMax = Math.max(1e-10, ...tfidfScores.values());

    for (const id of allIds) {
      const doc = this.docs!.get(id);
      if (!doc) continue;
      if (filter?.source && doc.source !== filter.source) continue;
      if (filter?.role && doc.role !== filter.role) continue;
      if (filter?.minTimestamp && doc.timestamp < filter.minTimestamp) continue;

      let score = ((bm25Scores.get(id) ?? 0) / bm25Max) * 0.4
                + ((tfidfScores.get(id) ?? 0) / tfidfMax) * 0.6;

      // Recency boost
      const age = Date.now() - doc.timestamp;
      if (age < 24 * 60 * 60 * 1000) score *= 1.10;
      else if (age < 7 * 24 * 60 * 60 * 1000) score *= 1.05;

      combined.set(id, score);
    }

    return [...combined.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, k)
      .map(([id, score]) => {
        const doc = this.docs!.get(id)!;
        return { id: doc.id, text: doc.text, source: doc.source, role: doc.role,
                 timestamp: doc.timestamp, score, sessionId: doc.sessionId };
      });
  }

  /** Get stats. */
  stats(): VDBStats {
    this.ensureLoaded();
    const sources: Record<string, number> = {};
    for (const doc of this.docs!.values()) sources[doc.source] = (sources[doc.source] ?? 0) + 1;

    let diskBytes = 0;
    try {
      if (fs.existsSync(this.docsFile)) diskBytes += fs.statSync(this.docsFile).size;
      if (fs.existsSync(this.indexFile)) diskBytes += fs.statSync(this.indexFile).size;
    } catch { /* */ }

    return {
      documentCount: this.docs!.size,
      termCount: this.globalTerms!.size,
      diskBytes,
      lastIndexed: Math.max(0, ...[...this.docs!.values()].map(d => d.timestamp)),
      sources,
    };
  }

  /** Build a knowledge graph from document similarities. */
  graph(threshold = 0.15, maxNodes = 500): GraphData {
    this.ensureLoaded();
    this.lastAccess = Date.now();

    const allDocs = [...this.docs!.values()];
    // Sample if too many docs
    const docs = allDocs.length > maxNodes
      ? this.sampleDocs(allDocs, maxNodes)
      : allDocs;
    const n = docs.length;
    if (n === 0) return { nodes: [], edges: [], clusters: 0, generated: Date.now() };

    // Compute TF-IDF magnitudes
    const mags = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let m = 0;
      for (let k = 0; k < docs[i].tfidf.length; k++) {
        const v = docs[i].tfidf[k];
        if (v !== undefined && v !== 0) m += v * v;
      }
      mags[i] = Math.sqrt(m);
    }

    // Build edges via pairwise cosine similarity
    const edges: GraphEdge[] = [];
    const connCount = new Map<string, number>();
    for (let i = 0; i < n; i++) {
      if (mags[i] === 0) continue;
      for (let j = i + 1; j < n; j++) {
        if (mags[j] === 0) continue;
        const sim = this.cosineSim(docs[i].tfidf, docs[j].tfidf, mags[i], mags[j]);
        if (sim > threshold) {
          edges.push({ source: docs[i].id, target: docs[j].id, weight: sim });
          connCount.set(docs[i].id, (connCount.get(docs[i].id) ?? 0) + 1);
          connCount.set(docs[j].id, (connCount.get(docs[j].id) ?? 0) + 1);
        }
      }
    }

    // K-means clustering
    const k = Math.max(2, Math.ceil(Math.sqrt(n / 2)));
    const clusters = this.kMeansClusters(docs, k);

    const nodes: GraphNode[] = docs.map((doc, i) => ({
      id: doc.id,
      label: doc.text.slice(0, 80).replace(/\n/g, ' '),
      source: doc.source,
      sessionId: doc.sessionId,
      timestamp: doc.timestamp,
      cluster: clusters[i],
      connections: connCount.get(doc.id) ?? 0,
    }));

    return { nodes, edges, clusters: k, generated: Date.now() };
  }

  /** Build a session-level graph (each node = session, edges = avg similarity). */
  sessionGraph(threshold = 0.1): GraphData {
    this.ensureLoaded();
    this.lastAccess = Date.now();

    // Group docs by sessionId
    const sessionDocs = new Map<string, StoredDocument[]>();
    for (const doc of this.docs!.values()) {
      const sid = doc.sessionId ?? 'orphan';
      if (!sessionDocs.has(sid)) sessionDocs.set(sid, []);
      sessionDocs.get(sid)!.push(doc);
    }

    const sessionIds = [...sessionDocs.keys()];
    const n = sessionIds.length;
    if (n === 0) return { nodes: [], edges: [], clusters: 0, generated: Date.now() };

    // Compute centroid TF-IDF for each session (average of doc vectors)
    const centroids: Map<string, number[]> = new Map();
    const centroidMags: Map<string, number> = new Map();
    for (const [sid, docs] of sessionDocs) {
      const centroid: number[] = [];
      for (const doc of docs) {
        for (let k = 0; k < doc.tfidf.length; k++) {
          const v = doc.tfidf[k];
          if (v !== undefined && v !== 0) {
            centroid[k] = (centroid[k] ?? 0) + v / docs.length;
          }
        }
      }
      centroids.set(sid, centroid);
      let mag = 0;
      for (let k = 0; k < centroid.length; k++) {
        const v = centroid[k];
        if (v !== undefined && v !== 0) mag += v * v;
      }
      centroidMags.set(sid, Math.sqrt(mag));
    }

    // Build edges
    const edges: GraphEdge[] = [];
    const connCount = new Map<string, number>();
    for (let i = 0; i < n; i++) {
      const ai = centroids.get(sessionIds[i])!;
      const mi = centroidMags.get(sessionIds[i])!;
      if (mi === 0) continue;
      for (let j = i + 1; j < n; j++) {
        const aj = centroids.get(sessionIds[j])!;
        const mj = centroidMags.get(sessionIds[j])!;
        if (mj === 0) continue;
        const sim = this.cosineSim(ai, aj, mi, mj);
        if (sim > threshold) {
          edges.push({ source: sessionIds[i], target: sessionIds[j], weight: sim });
          connCount.set(sessionIds[i], (connCount.get(sessionIds[i]) ?? 0) + 1);
          connCount.set(sessionIds[j], (connCount.get(sessionIds[j]) ?? 0) + 1);
        }
      }
    }

    // Cluster
    const k = Math.max(2, Math.ceil(Math.sqrt(n / 2)));
    // Create pseudo-docs for clustering
    const pseudoDocs = sessionIds.map(sid => {
      const docs = sessionDocs.get(sid)!;
      return {
        tfidf: centroids.get(sid)!,
        text: docs[0].text,
        source: docs[0].source,
      };
    });
    const clusters = this.kMeansRaw(pseudoDocs.map(d => d.tfidf), k);

    const nodes: GraphNode[] = sessionIds.map((sid, i) => {
      const docs = sessionDocs.get(sid)!;
      const latest = docs.reduce((a, b) => a.timestamp > b.timestamp ? a : b);
      return {
        id: sid,
        label: `${sid.slice(0, 30)} (${docs.length} msgs)`,
        source: docs[0].source,
        sessionId: sid,
        timestamp: latest.timestamp,
        cluster: clusters[i],
        connections: connCount.get(sid) ?? 0,
      };
    });

    return { nodes, edges, clusters: k, generated: Date.now() };
  }

  // ── Graph helpers ────────────────────────────────────────────────────

  private cosineSim(a: number[], b: number[], magA: number, magB: number): number {
    let dot = 0;
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const va = a[i], vb = b[i];
      if (va !== undefined && va !== 0 && vb !== undefined && vb !== 0) {
        dot += va * vb;
      }
    }
    return magA > 0 && magB > 0 ? dot / (magA * magB) : 0;
  }

  private sampleDocs(docs: StoredDocument[], max: number): StoredDocument[] {
    // Stratified sample: keep recent + random
    const sorted = [...docs].sort((a, b) => b.timestamp - a.timestamp);
    const recent = sorted.slice(0, Math.floor(max * 0.3));
    const rest = sorted.slice(Math.floor(max * 0.3));
    const needed = max - recent.length;
    // Fisher-Yates partial shuffle
    for (let i = 0; i < Math.min(needed, rest.length); i++) {
      const j = i + Math.floor(Math.random() * (rest.length - i));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    return [...recent, ...rest.slice(0, needed)];
  }

  private kMeansClusters(docs: StoredDocument[], k: number, iters = 20): number[] {
    return this.kMeansRaw(docs.map(d => d.tfidf), k, iters);
  }

  private kMeansRaw(vectors: number[][], k: number, iters = 20): number[] {
    const n = vectors.length;
    if (n <= k) return vectors.map((_, i) => i % k);

    // Init centroids: k-means++ style
    const centroids: number[][] = [];
    const used = new Set<number>();
    let first = Math.floor(Math.random() * n);
    centroids.push([...vectors[first]]); used.add(first);

    for (let c = 1; c < k; c++) {
      let maxDist = -1, bestIdx = 0;
      for (let i = 0; i < n; i++) {
        if (used.has(i)) continue;
        let minD = Infinity;
        for (const cent of centroids) {
          const d = this.vecDist(vectors[i], cent);
          if (d < minD) minD = d;
        }
        if (minD > maxDist) { maxDist = minD; bestIdx = i; }
      }
      centroids.push([...vectors[bestIdx]]); used.add(bestIdx);
    }

    const assignments = new Int32Array(n);

    for (let iter = 0; iter < iters; iter++) {
      // Assign
      for (let i = 0; i < n; i++) {
        let bestC = 0, bestD = Infinity;
        for (let c = 0; c < k; c++) {
          const d = this.vecDist(vectors[i], centroids[c]);
          if (d < bestD) { bestD = d; bestC = c; }
        }
        assignments[i] = bestC;
      }
      // Update centroids
      const counts = new Float64Array(k);
      const sums: number[][] = centroids.map(() => []);
      for (let i = 0; i < n; i++) {
        const c = assignments[i];
        counts[c]++;
        const v = vectors[i];
        const s = sums[c];
        for (let j = 0; j < v.length; j++) {
          if (v[j] !== undefined && v[j] !== 0) {
            s[j] = (s[j] ?? 0) + v[j];
          }
        }
      }
      for (let c = 0; c < k; c++) {
        if (counts[c] === 0) continue;
        centroids[c] = sums[c].map(v => (v ?? 0) / counts[c]);
      }
    }
    return [...assignments];
  }

  private vecDist(a: number[], b: number[]): number {
    let sum = 0;
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const d = (a[i] ?? 0) - (b[i] ?? 0);
      sum += d * d;
    }
    return sum;
  }

  /** Evict from memory. Data stays on disk. */
  evict(): void {
    if (this.dirty) this.saveIndex();
    this.docs = null; this.bm25 = null; this.globalTerms = null;
    this.seenHashes.clear();
  }

  /** Check idle and evict if needed. */
  checkIdle(): boolean {
    if (this.docs && this.lastAccess > 0 && Date.now() - this.lastAccess > this.idleTimeout) {
      this.evict(); return true;
    }
    return false;
  }

  /** Compact JSONL — remove dupes, rewrite clean. */
  compact(): number {
    this.ensureLoaded();
    const before = fs.existsSync(this.docsFile) ? fs.statSync(this.docsFile).size : 0;
    const lines: string[] = [];
    for (const doc of this.docs!.values()) {
      lines.push(JSON.stringify({
        id: doc.id, text: doc.text, source: doc.source, role: doc.role,
        timestamp: doc.timestamp, sessionId: doc.sessionId, metadata: doc.metadata,
        terms: doc.terms, tfidf: doc.tfidf.filter(v => v !== undefined),
      }));
    }
    const tmp = this.docsFile + '.tmp';
    fs.writeFileSync(tmp, lines.join('\n') + '\n');
    fs.renameSync(tmp, this.docsFile);
    this.saveIndex();
    return before - fs.statSync(this.docsFile).size;
  }

  // ── BM25 ─────────────────────────────────────────────────────────────

  private bm25Search(queryTerms: string[], k1 = 1.5, b = 0.75): Map<string, number> {
    const scores = new Map<string, number>();
    const idx = this.bm25!;
    for (const term of queryTerms) {
      const postings = idx.postings.get(term);
      if (!postings) continue;
      const df = postings.size;
      const idf = Math.log((idx.N - df + 0.5) / (df + 0.5) + 1);
      for (const [docId, tf] of postings) {
        const dl = idx.docLengths.get(docId) ?? 0;
        const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / idx.avgDl));
        scores.set(docId, (scores.get(docId) ?? 0) + idf * tfNorm);
      }
    }
    return scores;
  }

  // ── TF-IDF Cosine ────────────────────────────────────────────────────

  private tfidfSearch(queryTerms: string[]): Map<string, number> {
    const scores = new Map<string, number>();
    const queryTf = new Map<string, number>();
    for (const t of queryTerms) queryTf.set(t, (queryTf.get(t) ?? 0) + 1);

    const queryVec = new Map<number, number>();
    for (const [term, count] of queryTf) {
      const idx = this.globalTerms!.get(term);
      if (idx === undefined) continue;
      const tf = count / queryTerms.length;
      const df = this.bm25!.postings.get(term)?.size ?? 0;
      const idf = df > 0 ? Math.log(this.bm25!.N / df) : 0;
      queryVec.set(idx, tf * idf);
    }
    if (queryVec.size === 0) return scores;

    let queryMag = 0;
    for (const v of queryVec.values()) queryMag += v * v;
    queryMag = Math.sqrt(queryMag);
    if (queryMag === 0) return scores;

    for (const [docId, doc] of this.docs!) {
      let dot = 0, docMag = 0;
      for (let i = 0; i < doc.tfidf.length; i++) {
        if (doc.tfidf[i] === undefined || doc.tfidf[i] === 0) continue;
        docMag += doc.tfidf[i] * doc.tfidf[i];
        const qv = queryVec.get(i);
        if (qv) dot += doc.tfidf[i] * qv;
      }
      docMag = Math.sqrt(docMag);
      if (docMag === 0 || dot === 0) continue;
      scores.set(docId, dot / (queryMag * docMag));
    }
    return scores;
  }

  // ── Persistence ──────────────────────────────────────────────────────

  private ensureLoaded(): void {
    if (this.docs) return;
    this.docs = new Map();
    this.globalTerms = new Map();
    this.bm25 = { postings: new Map(), docLengths: new Map(), avgDl: 0, N: 0 };

    if (fs.existsSync(this.docsFile)) {
      const lines = fs.readFileSync(this.docsFile, 'utf-8').split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const doc = JSON.parse(line) as StoredDocument;
          this.docs.set(doc.id, doc);
          this.seenHashes.add(crypto.createHash('md5').update(doc.text).digest('hex'));
          for (const term of doc.terms) {
            if (!this.globalTerms.has(term)) this.globalTerms.set(term, this.globalTerms.size);
          }
          this.bm25.N++;
          this.bm25.docLengths.set(doc.id, doc.terms.length);
          const tf = new Map<string, number>();
          for (const t of doc.terms) tf.set(t, (tf.get(t) ?? 0) + 1);
          for (const [term, count] of tf) {
            if (!this.bm25.postings.has(term)) this.bm25.postings.set(term, new Map());
            this.bm25.postings.get(term)!.set(doc.id, count);
          }
        } catch { /* skip corrupt */ }
      }
      if (this.bm25.N > 0) {
        let total = 0;
        for (const len of this.bm25.docLengths.values()) total += len;
        this.bm25.avgDl = total / this.bm25.N;
      }
    }
    this.lastAccess = Date.now();
  }

  private appendDoc(doc: StoredDocument): void {
    const line = JSON.stringify({
      id: doc.id, text: doc.text, source: doc.source, role: doc.role,
      timestamp: doc.timestamp, sessionId: doc.sessionId, metadata: doc.metadata,
      terms: doc.terms, tfidf: doc.tfidf.filter(v => v !== undefined),
    });
    fs.appendFileSync(this.docsFile, line + '\n');
  }

  private saveIndex(): void {
    const meta = {
      documentCount: this.docs?.size ?? 0,
      termCount: this.globalTerms?.size ?? 0,
      lastSaved: Date.now(),
    };
    fs.writeFileSync(this.indexFile, JSON.stringify(meta));
    this.dirty = false;
  }
}

// ── Session Ingester ─────────────────────────────────────────────────────

/** Extract indexable documents from a Symbiote session file. */
export function extractFromSession(sessionPath: string, source = 'whatsapp'): VDBDocument[] {
  const docs: VDBDocument[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
    const messages: Array<{ role: string; content: string | any; tool_calls?: any[] }> =
      raw.messages ?? raw;
    const sessionId = raw.sessionId ?? raw.id ?? path.basename(sessionPath, '.json');
    const baseTimestamp = raw.archivedAt ?? raw.createdAt ?? Date.now();

    const readable = messages.filter(m =>
      (m.role === 'user' || m.role === 'assistant') &&
      typeof m.content === 'string' &&
      m.content.trim().length > 10 &&
      !m.tool_calls?.length
    );

    for (let i = 0; i < readable.length; i++) {
      const msg = readable[i];
      const text = typeof msg.content === 'string' ? msg.content.trim() : '';
      if (text.length < 15) continue;
      if (text.includes('BLINK APPROACHING') || text.includes('BLINK COMPLETE')) continue;
      const indexText = text.length > 2000 ? text.slice(0, 2000) : text;
      docs.push({
        id: makeDocId(indexText, baseTimestamp + i),
        text: indexText, source, role: msg.role,
        timestamp: baseTimestamp + i * 1000, sessionId,
      });
    }
  } catch { /* corrupt */ }
  return docs;
}

/** Ingest all session archives from a sessions directory. */
export function ingestSessions(
  db: VectorDB, sessionsDir: string, source = 'whatsapp',
): { processed: number; indexed: number } {
  let processed = 0, indexed = 0;
  for (const dir of [sessionsDir, path.join(sessionsDir, 'archive')]) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
      let fileSource = source;
      if (file.includes('whatsapp')) fileSource = 'whatsapp';
      else if (file.includes('discord')) fileSource = 'discord';
      else if (file.includes('http')) fileSource = 'webchat';
      const docs = extractFromSession(path.join(dir, file), fileSource);
      const added = db.indexBatch(docs);
      processed += docs.length;
      indexed += added;
    }
  }
  return { processed, indexed };
}
