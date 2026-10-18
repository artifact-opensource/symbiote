# COMB — Session Continuity and Durable Memory

COMB is Symbiote's session-continuity interface. The VDB is its warm, searchable index; explicit distilled offloads are also written to an append-only JSONL archive and a Memograph-compatible graph snapshot.

## What It Does

The gateway indexes recent conversation turns and shutdown tails in the VDB. Those raw continuity records are not automatically promoted to curated cold memory. An agent can explicitly offload a concise, self-contained summary when a durable fact, decision, preference, or task checkpoint is worth retaining.

Two tools are available to agents:

| Tool | Description |
|------|-------------|
| `comb_recall` | Recall recent staged notes, or similarity-match durable offloads with a query |
| `comb_stage` | Stage a concise memory; when initialized, writes through the durable offload pipeline |
| `memory_offload` | Explicitly persist one distilled memory across the archive, Memograph, and VDB |

## Storage and Retrieval

`memory_offload` and initialized `comb_stage` write one JSONL record per coherent summary to `.symbiote/memory.jsonl` (override with `SYMBIOTE_MEMORY_ARCHIVE`), append a SHA-256-addressed LIVE shard to `symbiote_live.json` in the configured Memograph storage directory, and index that shard in the VDB. Repeated offloads of the same summary in the same session are idempotent. Writes are synchronous and errors are returned to the tool caller; the VDB is not treated as the only durable copy.

`comb_recall` without a query returns recent warm COMB notes. With a query, it searches the durable Symbiote graph namespace by VDB relevance. Retrieval uses BM25 and sparse TF-IDF, not dense neural embeddings. Memograph snapshots can also be imported from `MEMOGRAPH_STORAGE_DIR` or the sibling `memograph/.memograph_storage` directory; their graph ID, domain, scope, permissions, content type, version, parent hash, and relation IDs are retained in VDB metadata.

## Session Auto-Flush

When a session ends, the daemon stages the last four conversation messages in the VDB for continuity. Context truncation also absorbs eligible dropped messages into the VDB. These automatic paths are warm history, not distilled cold-memory promotion; use `memory_offload` for a deliberate long-term memory.

## Configuration

The `.vdb/` and `.symbiote/` directories are created automatically in the configured workspace. Set `SYMBIOTE_MEMORY_ARCHIVE` to move the JSONL archive, or `MEMOGRAPH_STORAGE_DIR` to use a non-default Memograph storage directory.

`memory_stats` reports warm VDB counts plus cold JSONL record and Memograph shard/hash-verification counts. It validates stored record structure and shard hashes without printing memory contents.

## Example

Agent offloads a distilled memory:

```
Agent: I'll retain the durable decision and its follow-up.
→ memory_offload("The deployment key expires on March 15, 2026; rotate it before that date.")
```

Next session, agent recalls:

```
→ comb_recall({ "query": "deployment key rotation deadline" })
=== COMB RECALL — Similarity-matched durable memories ===
...
```
