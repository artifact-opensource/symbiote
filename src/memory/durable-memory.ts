import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { VectorDB } from './vdb.js';
import { canonicalJson } from './memograph.js';

interface MemoGraphShard {
  shard_hash: string;
  content: Record<string, unknown>;
  owner: string;
  scope: string;
  domain: string;
  parent_hash: string | null;
  permissions: string[];
  timestamp: number;
  version: number;
  content_type: string;
}

interface MemoGraphSnapshot {
  _memograph_schema: number;
  nodes: Record<string, MemoGraphShard>;
  edges: Record<string, string[]>;
  reverse_edges: Record<string, string[]>;
}

interface DurableMemoryRecord {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  sessionId: string;
  source: string;
  summary: string;
  shard: MemoGraphShard;
}

export interface MemoryOffloadResult {
  id: string;
  shardHash: string;
  indexed: boolean;
  duplicate: boolean;
}

export interface DurableMemoryStats {
  archiveRecords: number;
  graphShards: number;
  verifiedShards: number;
  archivePath: string;
  graphPath: string;
}

const GRAPH_FILE = 'symbiote_live.json';
const OWNER = 'symbiote';
const SCOPE = 'agent:symbiote';

function hashShard(shard: Omit<MemoGraphShard, 'shard_hash' | 'timestamp'>): string {
  const payload = {
    content: shard.content,
    owner: shard.owner,
    scope: shard.scope,
    domain: shard.domain,
    parent_hash: shard.parent_hash,
    permissions: [...shard.permissions].sort(),
    version: shard.version,
    content_type: shard.content_type,
  };
  return crypto.createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}

function readSnapshot(filePath: string): MemoGraphSnapshot {
  if (!fs.existsSync(filePath)) {
    return { _memograph_schema: 2, nodes: {}, edges: {}, reverse_edges: {} };
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<MemoGraphSnapshot>;
  if (!parsed.nodes || typeof parsed.nodes !== 'object' || Array.isArray(parsed.nodes)
      || !parsed.edges || typeof parsed.edges !== 'object' || Array.isArray(parsed.edges)) {
    throw new Error(`Invalid Memograph graph snapshot: ${filePath}`);
  }
  return {
    _memograph_schema: parsed._memograph_schema ?? 2,
    nodes: parsed.nodes,
    edges: parsed.edges,
    reverse_edges: parsed.reverse_edges ?? {},
  };
}

function writeSnapshot(filePath: string, snapshot: MemoGraphSnapshot): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(snapshot), 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporaryPath); } catch { /* Preserve the primary persistence error. */ }
    throw error;
  }
}

function appendRecord(filePath: string, record: DurableMemoryRecord): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const descriptor = fs.openSync(filePath, 'a', 0o600);
  try {
    const line = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
    let offset = 0;
    while (offset < line.length) {
      offset += fs.writeSync(descriptor, line, offset, line.length - offset, null);
    }
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function readRecords(filePath: string): Map<string, DurableMemoryRecord> {
  const records = new Map<string, DurableMemoryRecord>();
  if (!fs.existsSync(filePath)) return records;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;
    let record: DurableMemoryRecord;
    try {
      record = JSON.parse(line) as DurableMemoryRecord;
    } catch (error) {
      throw new Error(`Invalid durable memory JSON at ${filePath}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    if (record.schemaVersion !== 1 || typeof record.id !== 'string' || !record.shard?.shard_hash) {
      throw new Error(`Invalid durable memory record at ${filePath}:${index + 1}`);
    }
    records.set(record.id, record);
  }
  return records;
}

function latestShard(snapshot: MemoGraphSnapshot): MemoGraphShard | undefined {
  return Object.values(snapshot.nodes)
    .filter(shard => shard?.domain === 'live' && shard.scope === SCOPE)
    .sort((left, right) => right.timestamp - left.timestamp)[0];
}

export class DurableMemory {
  private readonly archivePath: string;
  private readonly graphPath: string;
  private records: Map<string, DurableMemoryRecord> | null = null;

  constructor(
    private readonly database: VectorDB,
    archivePath: string,
    memographStorageDir: string,
  ) {
    this.archivePath = path.resolve(archivePath);
    this.graphPath = path.join(path.resolve(memographStorageDir), GRAPH_FILE);
  }

  offload(summary: string, sessionId = 'main', source = 'agent'): MemoryOffloadResult {
    const normalized = summary.trim();
    if (!normalized) throw new Error('A non-empty distilled memory summary is required.');
    if (normalized.length > 20_000) throw new Error('A distilled memory summary must be 20,000 characters or fewer.');
    if (!sessionId.trim()) throw new Error('A session ID is required for memory provenance.');

    const id = crypto.createHash('sha256')
      .update(`${sessionId.trim()}\0${normalized}`, 'utf8')
      .digest('hex');
    const records = this.getRecords();
    let record = records.get(id);
    const duplicate = record !== undefined;

    if (!record) {
      const snapshot = readSnapshot(this.graphPath);
      const parent = latestShard(snapshot);
      const createdAt = new Date().toISOString();
      const timestamp = Date.now() / 1000;
      const content = {
        summary: normalized,
        record_id: id,
        session_id: sessionId.trim(),
        source,
        created_at: createdAt,
      };
      const shardFields = {
        content,
        owner: OWNER,
        scope: SCOPE,
        domain: 'live',
        parent_hash: parent?.shard_hash ?? null,
        permissions: ['*'],
        version: 1,
        content_type: 'CONVERSATIONAL',
      };
      const shard: MemoGraphShard = {
        ...shardFields,
        shard_hash: hashShard(shardFields),
        timestamp,
      };
      record = { schemaVersion: 1, id, createdAt, sessionId: sessionId.trim(), source, summary: normalized, shard };
      appendRecord(this.archivePath, record);
      records.set(id, record);
    }

    const snapshot = readSnapshot(this.graphPath);
    if (!snapshot.nodes[record.shard.shard_hash]) {
      snapshot.nodes[record.shard.shard_hash] = record.shard;
      if (record.shard.parent_hash && snapshot.nodes[record.shard.parent_hash]) {
        const children = snapshot.edges[record.shard.parent_hash] ?? [];
        if (!children.includes(record.shard.shard_hash)) children.push(record.shard.shard_hash);
        snapshot.edges[record.shard.parent_hash] = children;
        const parents = snapshot.reverse_edges[record.shard.shard_hash] ?? [];
        if (!parents.includes(record.shard.parent_hash)) parents.push(record.shard.parent_hash);
        snapshot.reverse_edges[record.shard.shard_hash] = parents;
      }
      writeSnapshot(this.graphPath, snapshot);
    }

    const shard = record.shard;
    const graphId = GRAPH_FILE.replace(/\.json$/i, '');
    const namespace = `memograph:${graphId}:${shard.domain}:${shard.scope}`;
    const body = `Domain: ${shard.domain}\nScope: ${shard.scope}\nsummary: ${record.summary}`;
    const indexed = this.database.index({
      id: `memograph:${graphId}:${shard.shard_hash}`,
      text: body,
      source: 'memograph',
      role: 'memory',
      timestamp: shard.timestamp * 1000,
      namespace,
      sessionId: record.sessionId,
      metadata: {
        memographGraph: graphId,
        memographShard: JSON.stringify(shard),
        memoryShardHash: shard.shard_hash,
        memoryDomain: shard.domain,
        memoryScope: shard.scope,
        memoryOwner: shard.owner,
        memoryPermissions: JSON.stringify(shard.permissions),
        memoryParentHash: shard.parent_hash ?? '',
        memoryRelations: JSON.stringify(shard.parent_hash ? [`memograph:${graphId}:${shard.parent_hash}`] : []),
        memoryVersion: String(shard.version),
        memoryContentType: shard.content_type,
        memoryVerified: String(hashShard(shard) === shard.shard_hash),
      },
    });

    return { id, shardHash: shard.shard_hash, indexed, duplicate };
  }

  stats(): DurableMemoryStats {
    const records = this.getRecords();
    const snapshot = readSnapshot(this.graphPath);
    let verifiedShards = 0;
    for (const [key, shard] of Object.entries(snapshot.nodes)) {
      if (!shard || key !== shard.shard_hash || hashShard(shard) !== shard.shard_hash) {
        throw new Error(`Invalid Memograph shard in durable graph: ${key}`);
      }
      verifiedShards++;
    }
    return {
      archiveRecords: records.size,
      graphShards: Object.keys(snapshot.nodes).length,
      verifiedShards,
      archivePath: this.archivePath,
      graphPath: this.graphPath,
    };
  }

  private getRecords(): Map<string, DurableMemoryRecord> {
    if (!this.records) this.records = readRecords(this.archivePath);
    return this.records;
  }
}

export function resolveDurableMemoryArchive(workspace: string): string {
  return path.resolve(
    process.env.SYMBIOTE_MEMORY_ARCHIVE
      ?? path.join(workspace, '.symbiote', 'memory.jsonl'),
  );
}
