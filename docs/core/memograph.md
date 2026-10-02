# Memograph Integration

Symbiote can import Memograph graph snapshots into its workspace VDB. The graph files remain the source of truth; the VDB stores searchable shard records and enough metadata to preserve topology and provenance during retrieval.

## Storage Discovery

Set `MEMOGRAPH_STORAGE_DIR` to the directory containing Memograph JSON snapshots. If unset, Symbiote checks the sibling path `../memograph/.memograph_storage` relative to the configured workspace.

Both graph snapshots (`nodes` and `edges`) and `MemoryStore` shard JSON files are accepted. Files are read-only; Symbiote does not rewrite or migrate Memograph's source files.

## Imported Shard Data

Each shard is stored as an atomic VDB document. Its VDB metadata includes:

- Source graph ID and original shard hash
- Domain (`live`, `project`, `enterprise`) and scope
- Owner and permissions
- Parent hash, related shard IDs, version, and content type
- The serialized source shard for audit and re-import

Documents use separate `memograph:<graph>:<domain>:<scope>` namespaces. Identical text in different shards or scopes is not deduplicated across those identities. Re-importing the same graph is idempotent.

## Retrieval And Permissions

The context store ranks Memograph results using native VDB BM25/TF-IDF relevance, domain authority, and scope affinity. It may add up to two related shards per result, subject to the same token budget. Context labels preserve each shard's domain, scope, and hash prefix.

Symbiote's default retrieval actor is `agent`. A Memograph shard is included only when its permissions contain `agent` or `*`; malformed permission metadata fails closed. Configure `ContextStore` with a different actor when embedding the store in another runtime.

## Diagnostics

At startup, import summaries report indexed, skipped, and failed records. Parse, schema, edge, conversion, and indexing failures include the snapshot or shard identifier; a damaged record does not prevent other snapshots from loading.

Force a backfill and inspect the VDB with:

```bash
node dist/cli/vdb-maintenance.js ingest
node dist/cli/vdb-maintenance.js stats
```

## Retrieval Limits

The embedded VDB currently uses BM25 and sparse TF-IDF. Memograph adds topology, domain weighting, scope affinity, permission filtering, and bounded lineage expansion. It does not currently generate dense neural embeddings; dense vector search requires a configured embedding backend.