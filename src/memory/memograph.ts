import fs from 'node:fs';
import path from 'node:path';
import type { VDBDocument, VectorDB } from './vdb.js';

interface MemoGraphShard {
  shard_hash?: string;
  content?: unknown;
  owner?: string;
  scope?: string;
  domain?: string;
  parent_hash?: string | null;
  permissions?: string[];
  timestamp?: number;
  version?: number;
  content_type?: string;
}

interface MemoGraphSnapshot {
  nodes?: Record<string, MemoGraphShard>;
  edges?: Record<string, string[]>;
}

export interface MemoGraphImportResult {
  files: number;
  shards: number;
  indexed: number;
  skipped: number;
  failures: number;
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join('\n');
  if (!value || typeof value !== 'object') return value == null ? '' : String(value);
  return Object.entries(value as Record<string, unknown>)
    .map(([key, child]) => `${key}: ${contentText(child)}`)
    .filter(line => line.trim().length > 0)
    .join('\n');
}

export function resolveMemoGraphStorageDir(workspace: string, configuredPath = process.env.MEMOGRAPH_STORAGE_DIR): string {
  if (configuredPath) return path.resolve(configuredPath);
  return path.resolve(workspace, '..', 'memograph', '.memograph_storage');
}

export function importMemoGraphSnapshots(
  database: VectorDB,
  storageDir: string,
): MemoGraphImportResult {
  const result: MemoGraphImportResult = { files: 0, shards: 0, indexed: 0, skipped: 0, failures: 0 };
  const fail = (stage: string, target: string, error: unknown) => {
    result.failures++;
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[memograph] ${stage} failed (${target}): ${detail}`);
  };

  let filenames: string[];
  try {
    if (!fs.existsSync(storageDir)) {
      console.info(`[memograph] storage not found; skipping import: ${storageDir}`);
      return result;
    }
    const pending = [storageDir];
    filenames = [];
    while (pending.length > 0) {
      const directory = pending.pop()!;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (entry.name !== '.index' && entry.name !== '.events') {
            pending.push(path.join(directory, entry.name));
          }
        } else if (entry.isFile() && entry.name.endsWith('.json') && entry.name !== 'index.json') {
          filenames.push(path.join(directory, entry.name));
        }
      }
    }
    filenames.sort();
  } catch (error) {
    fail('storage scan', storageDir, error);
    return result;
  }

  for (const filename of filenames) {
    const filePath = filename;
    let snapshot: MemoGraphSnapshot;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as MemoGraphSnapshot & MemoGraphShard;
      if (!parsed.nodes && parsed.shard_hash && parsed.content !== undefined) {
        snapshot = { nodes: { [parsed.shard_hash]: parsed } };
      } else {
        snapshot = parsed;
      }
    } catch (error) {
      result.skipped++;
      fail('snapshot parse', filename, error);
      continue;
    }

    if (!snapshot.nodes || typeof snapshot.nodes !== 'object' || Array.isArray(snapshot.nodes)) {
      result.skipped++;
      fail('snapshot validation', filename, new Error('expected an object-valued nodes map'));
      continue;
    }
    result.files++;
    const graphId = path.relative(storageDir, filePath).replace(/[\\/]/g, ':').replace(/\.json$/i, '');
    const children = new Map<string, Set<string>>();
    for (const [parentHash, childHashes] of Object.entries(snapshot.edges ?? {})) {
      if (!Array.isArray(childHashes)) {
        fail('edge validation', `${filename}:${parentHash}`, new Error('expected child hash array'));
        continue;
      }
      for (const childHash of childHashes) {
        const related = children.get(parentHash) ?? new Set<string>();
        related.add(childHash);
        children.set(parentHash, related);
      }
    }

    const documents: VDBDocument[] = [];
    for (const [nodeKey, shard] of Object.entries(snapshot.nodes)) {
      result.shards++;
      if (!shard || typeof shard !== 'object' || Array.isArray(shard)) {
        result.skipped++;
        fail('shard validation', `${filename}:${nodeKey}`, new Error('expected shard object'));
        continue;
      }
      try {
      const shardHash = shard.shard_hash ?? nodeKey;
      const domain = shard.domain ?? 'live';
      const scope = shard.scope ?? 'default';
      const relations = new Set(children.get(shardHash) ?? []);
      if (shard.parent_hash) relations.add(shard.parent_hash);
      const body = contentText(shard.content);
      if (!body.trim()) {
        result.skipped++;
        continue;
      }

      const timestamp = shard.timestamp ?? Date.now();
      documents.push({
        id: `memograph:${graphId}:${shardHash}`,
        text: `Domain: ${domain}\nScope: ${scope}\n${body}`,
        source: 'memograph',
        role: 'memory',
        timestamp: timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp,
        namespace: `memograph:${graphId}:${domain}:${scope}`,
        sessionId: graphId,
        metadata: {
          memographGraph: graphId,
          memographShard: JSON.stringify(shard),
          memoryShardHash: shardHash,
          memoryDomain: domain,
          memoryScope: scope,
          memoryOwner: shard.owner ?? '',
          memoryPermissions: JSON.stringify(shard.permissions ?? []),
          memoryParentHash: shard.parent_hash ?? '',
          memoryRelations: JSON.stringify([...relations].map(hash => `memograph:${graphId}:${hash}`)),
          memoryVersion: String(shard.version ?? 1),
          memoryContentType: shard.content_type ?? 'CONVERSATIONAL',
        },
      });
      } catch (error) {
        result.skipped++;
        fail('shard conversion', `${filename}:${nodeKey}`, error);
      }
    }

    for (const document of documents) {
      try {
        if (database.index(document)) result.indexed++;
        else result.skipped++;
      } catch (error) {
        fail('shard indexing', document.id, error);
      }
    }
  }

  console.info(`[memograph] import complete: ${result.indexed} indexed, ${result.skipped} skipped, ${result.failures} failures across ${result.files} snapshots`);
  return result;
}