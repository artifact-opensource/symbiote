# COMB — VDB-Backed Session Memory

COMB is Symbiote's session-continuity interface over the embedded VDB. Staged notes and recent session context are indexed as separate records in the workspace's `.vdb` store. No external memory daemon or archive rollup service is required.

## What It Does

COMB gives agents persistent memory across sessions. The gateway stages conversation tails at shutdown and exposes tools for explicit recall/staging. VDB session ingestion runs periodically and on startup.

Two tools are available to agents:

| Tool | Description |
|------|-------------|
| `comb_recall` | Recall staged memories from previous sessions |
| `comb_stage` | Stage information for the next session |

## Storage and Retrieval

`comb_stage` indexes text with source `comb`; `comb_recall` queries recent COMB records. The VDB stores append-only JSONL documents and builds BM25 + sparse TF-IDF hybrid search indexes on demand. Session and Memograph records remain in distinct namespaces.

Memograph snapshots can be imported from `MEMOGRAPH_STORAGE_DIR` or the sibling `memograph/.memograph_storage` directory. Imported shards preserve graph ID, domain, scope, permissions, content type, version, parent hash, and relation IDs in VDB metadata.

## Session Auto-Flush

When a session ends, the daemon calls `flushMessages()` to stage the last four conversation messages. VDB also indexes new session messages periodically, providing searchable long-term recall independently from the active context window.

## Configuration

COMB works out of the box. The `.vdb/` directory is created automatically in the configured workspace. Set `MEMOGRAPH_STORAGE_DIR` to import graphs from a non-default location.

## Example

Agent stages context:

```
Agent: I'll remember that the deploy key expires on March 15.
→ comb_stage("Deploy key expires March 15, 2026. Needs rotation before then.")
```

Next session, agent recalls:

```
→ comb_recall()
=== COMB RECALL — Session Continuity ===

--- Staged [2026-03-06] (3 entries) ---
Deploy key expires March 15, 2026. Needs rotation before then.

[Session: discord-main-1475929150488449138-5]
Agent: Completed the docs overhaul and pushed to all remotes.
```
