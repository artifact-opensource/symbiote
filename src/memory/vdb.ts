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
  namespace?: string;
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
  namespace?: string;
  score: number;
  sessionId?: string;
  metadata?: Record<string, string>;
}

export interface VDBStats {
  documentCount: number;
  termCount: number;
  diskBytes: number;
  lastIndexed: number;
  sources: Record<string, number>;
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

function makeDocId(text: string, timestamp: number, namespace = ''): string {
  return crypto.createHash('md5').update(`${namespace}:${timestamp}:${text.slice(0, 200)}`).digest('hex').slice(0, 12);
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

  /** Index a document. Deduplicates by stable document identity and content. */
  index(doc: VDBDocument): boolean {
    this.ensureLoaded();

    const stored = this.addDocument(doc);
    if (!stored) return false;
    this.appendDoc(stored);
    return true;
  }

  /** Replace a namespace atomically in the in-memory index and compact it to disk. */
  syncNamespace(namespace: string, documents: VDBDocument[]): { added: number; removed: number; unchanged: boolean } {
    this.ensureLoaded();
    if (!namespace.trim()) throw new Error('A namespace is required to synchronize vector documents.');
    if (documents.some(document => document.namespace !== namespace)) {
      throw new Error('Every synchronized document must belong to the requested namespace.');
    }
    const ids = new Set<string>();
    for (const document of documents) {
      if (!document.id) throw new Error('Synchronized vector documents must have stable IDs.');
      if (ids.has(document.id)) throw new Error(`Duplicate vector document ID in namespace "${namespace}": ${document.id}`);
      ids.add(document.id);
    }
    const previous = [...this.docs!.values()].filter(document => document.namespace === namespace);
    const incomingById = new Map(documents.map(document => [document.id, document]));
    const sameDocument = (left: VDBDocument, right: VDBDocument) =>
      left.id === right.id && left.text === right.text && left.source === right.source
      && left.role === right.role && left.timestamp === right.timestamp && left.namespace === right.namespace
      && left.sessionId === right.sessionId && JSON.stringify(left.metadata ?? {}) === JSON.stringify(right.metadata ?? {});
    const priorById = new Map(previous.map(document => [document.id, document]));
    const unchanged = previous.length === incomingById.size
      && [...incomingById].every(([id, document]) => {
        const prior = priorById.get(id);
        return prior !== undefined && sameDocument(prior, document);
      });
    if (unchanged) return { added: 0, removed: 0, unchanged: true };

    const preserved = [...this.docs!.values()]
      .filter(document => document.namespace !== namespace)
      .map(({ terms: _terms, tfidf: _tfidf, ...document }) => document);
    const replacements = [...incomingById.values()];
    const allDocuments = [...preserved, ...replacements];
    this.docs = new Map();
    this.globalTerms = new Map();
    this.bm25 = { postings: new Map(), docLengths: new Map(), avgDl: 0, N: 0 };
    this.seenHashes.clear();
    this.dirty = false;
    for (const document of allDocuments) this.addDocument(document);
    this.writeDocuments();
    this.saveIndex();
    return {
      added: replacements.filter(document => !priorById.has(document.id)).length,
      removed: previous.filter(document => !incomingById.has(document.id)).length,
      unchanged: false,
    };
  }

  private addDocument(doc: VDBDocument): StoredDocument | undefined {
    const id = doc.id || makeDocId(doc.text, doc.timestamp, `${doc.namespace ?? ''}:${doc.source}:${doc.sessionId ?? ''}`);
    const deduplicationKey = doc.namespace ? `${id}\0${doc.text}` : doc.text;
    const hash = crypto.createHash('md5').update(deduplicationKey).digest('hex');
    if (this.seenHashes.has(hash)) return undefined;
    this.seenHashes.add(hash);

    if (this.docs!.has(id)) return undefined;

    const terms = tokenize(doc.text);
    if (terms.length === 0) return undefined;

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
    return stored;
  }

  /** Batch index. Returns count of new documents. */
  indexBatch(docs: VDBDocument[]): number {
    let added = 0;
    for (const doc of docs) { if (this.index(doc)) added++; }
    if (this.dirty) this.saveIndex();
    return added;
  }

  /** Return the complete indexed corpus without exposing internal index fields. */
  listDocuments(): VDBDocument[] {
    this.ensureLoaded();
    this.lastAccess = Date.now();
    return [...this.docs!.values()].map(({ terms: _terms, tfidf: _tfidf, ...doc }) => doc);
  }

  /** Return exact cosine-similarity neighbors from the VDB's sparse term vectors. */
  similarityEdges(neighborsPerDocument = 5, minimumSimilarity = 0.08): Array<{ source: string; target: string; similarity: number }> {
    if (!Number.isInteger(neighborsPerDocument) || neighborsPerDocument < 1) {
      throw new RangeError('neighborsPerDocument must be a positive integer.');
    }
    if (!Number.isFinite(minimumSimilarity) || minimumSimilarity < 0 || minimumSimilarity > 1) {
      throw new RangeError('minimumSimilarity must be between 0 and 1.');
    }
    this.ensureLoaded();
    this.lastAccess = Date.now();
    const docs = [...this.docs!.values()];
    const vectors: Array<Map<string, number>> = [];
    const norms: number[] = [];
    const postings = new Map<string, Array<{ index: number; weight: number }>>();

    for (let index = 0; index < docs.length; index++) {
      const doc = docs[index];
      const counts = new Map<string, number>();
      for (const term of doc.terms) counts.set(term, (counts.get(term) ?? 0) + 1);
      const vector = new Map<string, number>();
      let magnitudeSquared = 0;
      for (const [term, count] of counts) {
        const documentFrequency = this.bm25!.postings.get(term)?.size ?? 0;
        const inverseDocumentFrequency = Math.log(1 + (docs.length + 1) / (documentFrequency + 1));
        const weight = count / Math.max(1, doc.terms.length) * inverseDocumentFrequency;
        vector.set(term, weight);
        magnitudeSquared += weight * weight;
        const termPostings = postings.get(term) ?? [];
        termPostings.push({ index, weight });
        postings.set(term, termPostings);
      }
      vectors.push(vector);
      norms.push(Math.sqrt(magnitudeSquared));
    }

    const topNeighbors = docs.map(() => [] as Array<{ index: number; similarity: number }>);
    const keepBest = (list: Array<{ index: number; similarity: number }>, candidate: { index: number; similarity: number }) => {
      const existing = list.findIndex(item => item.index === candidate.index);
      if (existing >= 0) {
        if (list[existing].similarity >= candidate.similarity) return;
        list.splice(existing, 1);
      }
      const insertion = list.findIndex(item =>
        item.similarity < candidate.similarity
          || (item.similarity === candidate.similarity && docs[item.index].id > docs[candidate.index].id),
      );
      list.splice(insertion < 0 ? list.length : insertion, 0, candidate);
      if (list.length > neighborsPerDocument) list.pop();
    };

    for (let left = 0; left < docs.length; left++) {
      if (norms[left] === 0) continue;
      const dotProducts = new Map<number, number>();
      for (const [term, weight] of vectors[left]) {
        for (const posting of postings.get(term) ?? []) {
          if (posting.index <= left) continue;
          dotProducts.set(posting.index, (dotProducts.get(posting.index) ?? 0) + weight * posting.weight);
        }
      }
      for (const [right, dot] of dotProducts) {
        if (norms[right] === 0) continue;
        const similarity = dot / (norms[left] * norms[right]);
        if (similarity < minimumSimilarity) continue;
        keepBest(topNeighbors[left], { index: right, similarity });
        keepBest(topNeighbors[right], { index: left, similarity });
      }
    }

    const edges = new Map<string, { source: string; target: string; similarity: number }>();
    for (let index = 0; index < topNeighbors.length; index++) {
      for (const neighbor of topNeighbors[index]) {
        const leftId = docs[index].id;
        const rightId = docs[neighbor.index].id;
        const source = leftId < rightId ? leftId : rightId;
        const target = leftId < rightId ? rightId : leftId;
        edges.set(`${source}\0${target}`, { source, target, similarity: neighbor.similarity });
      }
    }
    return [...edges.values()].sort((left, right) =>
      right.similarity - left.similarity || left.source.localeCompare(right.source) || left.target.localeCompare(right.target),
    );
  }

  /** Hybrid search: BM25 + TF-IDF cosine. */
  search(query: string, k = 5, filter?: {
    source?: string;
    role?: string;
    namespace?: string;
    minTimestamp?: number;
    metadata?: Record<string, string>;
  }): SearchResult[] {
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
      if (filter?.namespace && doc.namespace !== filter.namespace) continue;
      if (filter?.minTimestamp && doc.timestamp < filter.minTimestamp) continue;
      if (filter?.metadata && Object.entries(filter.metadata).some(([key, value]) => doc.metadata?.[key] !== value)) continue;

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
        return {
          id: doc.id, text: doc.text, source: doc.source, role: doc.role,
          timestamp: doc.timestamp, namespace: doc.namespace, score,
          sessionId: doc.sessionId, metadata: doc.metadata,
        };
      });
  }

  getDocument(id: string): VDBDocument | undefined {
    this.ensureLoaded();
    const doc = this.docs!.get(id);
    if (!doc) return undefined;
    const { terms: _terms, tfidf: _tfidf, ...document } = doc;
    return document;
  }

  /** Get the k most recent documents from a specific source (chronological). */
  recent(source: string, k = 10): Array<{ text: string; timestamp: number; id: string }> {
    this.ensureLoaded();
    this.lastAccess = Date.now();

    const matching: Array<{ text: string; timestamp: number; id: string }> = [];
    for (const doc of this.docs!.values()) {
      if (doc.source === source) {
        matching.push({ text: doc.text, timestamp: doc.timestamp, id: doc.id });
      }
    }

    // Sort by timestamp descending (most recent first), take k
    matching.sort((a, b) => b.timestamp - a.timestamp);
    return matching.slice(0, k);
  }

  /** Get stats. */
  stats(): VDBStats {
    this.ensureLoaded();
    const sources: Record<string, number> = {};
    let lastIndexed = 0;
    for (const doc of this.docs!.values()) {
      sources[doc.source] = (sources[doc.source] ?? 0) + 1;
      lastIndexed = Math.max(lastIndexed, doc.timestamp);
    }

    let diskBytes = 0;
    try {
      if (fs.existsSync(this.docsFile)) diskBytes += fs.statSync(this.docsFile).size;
      if (fs.existsSync(this.indexFile)) diskBytes += fs.statSync(this.indexFile).size;
    } catch { /* */ }

    return {
      documentCount: this.docs!.size,
      termCount: this.globalTerms!.size,
      diskBytes,
      lastIndexed,
      sources,
    };
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
        timestamp: doc.timestamp, namespace: doc.namespace, sessionId: doc.sessionId, metadata: doc.metadata,
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
          for (const term of doc.terms) {
            if (!this.globalTerms.has(term)) this.globalTerms.set(term, this.globalTerms.size);
          }
          const counts = new Map<string, number>();
          for (const term of doc.terms) counts.set(term, (counts.get(term) ?? 0) + 1);
          doc.tfidf = [];
          for (const [term, count] of counts) {
            const termIndex = this.globalTerms.get(term);
            if (termIndex !== undefined) doc.tfidf[termIndex] = count / Math.max(1, doc.terms.length);
          }
          this.docs.set(doc.id, doc);
          const deduplicationKey = doc.namespace ? `${doc.id}\0${doc.text}` : doc.text;
          this.seenHashes.add(crypto.createHash('md5').update(deduplicationKey).digest('hex'));
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
    fs.appendFileSync(this.docsFile, `${JSON.stringify(this.serializeDocument(doc))}\n`);
  }

  private serializeDocument(doc: StoredDocument): StoredDocument {
    return { ...doc, tfidf: doc.tfidf.filter(value => value !== undefined) };
  }

  private writeDocuments(): void {
    const lines = [...this.docs!.values()].map(document => JSON.stringify(this.serializeDocument(document)));
    const temporary = `${this.docsFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${lines.join('\n')}\n`);
    fs.renameSync(temporary, this.docsFile);
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

const sharedDatabases = new Map<string, VectorDB>();

export function getSharedVectorDB(baseDir: string): VectorDB {
  const workspace = path.resolve(baseDir);
  let database = sharedDatabases.get(workspace);
  if (!database) {
    database = new VectorDB(workspace);
    sharedDatabases.set(workspace, database);
  }
  return database;
}

// ── Session Ingester ─────────────────────────────────────────────────────

/** Extract indexable documents from a Symbiote session file. */
export function extractFromSession(sessionPath: string, source = 'whatsapp'): VDBDocument[] {
  const docs: VDBDocument[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
    const messages: Array<{ role: string; content: string | any; tool_calls?: any[]; timestamp?: number }> =
      raw.messages ?? raw;
    const sessionId = raw.sessionId ?? raw.id ?? path.basename(sessionPath, '.json');
    const baseTimestamp = raw.archivedAt ?? raw.createdAt ?? Date.now();

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (
        (msg.role !== 'user' && msg.role !== 'assistant') ||
        typeof msg.content !== 'string' ||
        msg.content.trim().length <= 10 ||
        msg.tool_calls?.length
      ) continue;
      const text = typeof msg.content === 'string' ? msg.content.trim() : '';
      if (text.length < 15) continue;
      if (text.includes('BLINK APPROACHING') || text.includes('BLINK COMPLETE')) continue;
      const indexText = text.length > 2000 ? text.slice(0, 2000) : text;
      const timestamp = typeof msg.timestamp === 'number'
        ? msg.timestamp
        : baseTimestamp + i * 1000;
      docs.push({
        id: makeSessionDocumentId(indexText, sessionId, i, msg.role),
        text: indexText, source, role: msg.role,
        timestamp, sessionId, namespace: `session:${sessionId}`,
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
  const visit = (directory: string): void => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(filePath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      let fileSource = source;
      if (entry.name.includes('whatsapp')) fileSource = 'whatsapp';
      else if (entry.name.includes('discord')) fileSource = 'discord';
      else if (entry.name.includes('http') || entry.name.includes('web')) fileSource = 'webchat';
      const docs = extractFromSession(filePath, fileSource);
      const added = db.indexBatch(docs);
      processed += docs.length;
      indexed += added;
    }
  };
  visit(sessionsDir);
  return { processed, indexed };
}

export function makeSessionDocumentId(text: string, sessionId: string, messageIndex: number, role: string): string {
  return makeDocId(text, messageIndex, `session:${sessionId}:${role}`);
}
