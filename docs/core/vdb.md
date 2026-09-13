# VDB — Embedded Persistent Memory

Zero-dependency embedded database for persistent, searchable memory across all conversations. Pure TypeScript. File-backed. So light it doesn't even exist until you need it.

## What It Does

VDB gives agents long-term memory. Every conversation — WhatsApp, Discord, webchat, COMB entries — becomes searchable. The agent can recall past decisions, previous conversations, and staged context without external databases.

Three tools expose it:

| Tool | Description |
|------|-------------|
| `memory_recall` | Search persistent memory by query |
| `memory_ingest` | Bootstrap memory from session archives |
| `memory_stats` | Database statistics and health |

## Architecture

```
workspace/.vdb/
├── documents.jsonl    # Append-only document store
└── index.json         # Index metadata (doc count, term count, last saved)
```

### Search Engine

VDB uses a hybrid retrieval strategy combining two algorithms:

- **BM25** (40% weight) — keyword matching with term frequency, inverse document frequency, and document length normalization. The standard for information retrieval.
- **TF-IDF cosine similarity** (60% weight) — sparse vector comparison for semantic-adjacent matching. Captures term importance across the corpus.

Final scores are normalized and combined:

```
score = (bm25_normalized × 0.4) + (tfidf_normalized × 0.6)
```

A recency boost is applied: documents from the last 24 hours get a 10% boost, last 7 days get 5%.

### Storage

Documents are stored in JSONL (one JSON object per line), append-only. This makes writes crash-safe — a partial write corrupts at most one line, and the rest of the file remains valid.

Each document stores:

| Field | Description |
|-------|-------------|
| `id` | Content-derived hash (MD5 of timestamp + text prefix) |
| `text` | The actual content (max 2000 chars) |
| `source` | Origin channel: `whatsapp`, `discord`, `webchat`, `comb` |
| `role` | `user`, `assistant`, or `context` |
| `timestamp` | Epoch milliseconds |
| `terms` | Pre-tokenized for BM25 (lowercase, stop words removed) |
| `tfidf` | Sparse TF-IDF vector |

### Deduplication

Documents are deduplicated by content hash (MD5 of full text). The same message indexed twice is silently skipped.

### Memory Management

VDB is lazy-loaded — the index stays on disk until the first query. After the configured idle timeout (default: 5 minutes), the in-memory index is evicted. Data remains on disk and is reloaded on next access.

## Auto-Ingestion

VDB includes a background ingestion system:

- **Real-time pulse** — every 5 seconds during active conversations, new messages are indexed incrementally
- **Session archive ingestion** — past session files are scanned and indexed on first `memory_recall` call (max once per 10 minutes)
- **Source detection** — session filenames are parsed to determine source (`whatsapp-*`, `discord-*`, `http-*`)

### What Gets Indexed

- User and assistant messages (≥15 characters)
- COMB staged entries
- Manually indexed content

### What Gets Filtered

- Tool calls and tool results (noise)
- System prompts (already in context)
- Blink markers and internal signals
- Messages shorter than 15 characters

## Tools

### memory_recall

```json
{ "query": "deploy key rotation", "k": 5, "source": "whatsapp" }
```

Returns the top `k` results ranked by hybrid score, with timestamps and source attribution.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | required | Search query |
| `k` | number | `5` | Number of results |
| `source` | string | all | Filter: `whatsapp`, `discord`, `webchat`, `comb` |

### memory_ingest

```json
{}
```

Scans all session directories and indexes conversation history. Run once to bootstrap, then auto-ingestion handles new sessions.

### memory_stats

```json
{}
```

Returns document count, term count, disk usage, last indexed timestamp, and per-source document counts.

## Configuration

VDB works out of the box with zero configuration. The `.vdb/` directory is created automatically in the agent's workspace on first use.

| Setting | Default | Description |
|---------|---------|-------------|
| Idle timeout | 5 minutes | Evict in-memory index after inactivity |
| Auto-ingest interval | 10 minutes | Minimum time between auto-ingestion runs |
| Max document text | 2000 chars | Longer messages are truncated |

## Compact

Over time, the JSONL file may accumulate redundancy. VDB provides a `compact()` method that deduplicates and rewrites the file cleanly. This is handled internally — no user action required.

## Relationship to HEKTOR

Enterprise deployments may also run HEKTOR (an external BM25 + vector hybrid search daemon with 384-dimension MiniLM embeddings). VDB and HEKTOR serve different purposes:

| | VDB | HEKTOR |
|---|-----|--------|
| **Scope** | Conversation memory | Workspace-wide file indexing |
| **Dependencies** | Zero (pure TypeScript) | Python, ONNX, MiniLM |
| **Documents** | Session messages, COMB | 39K+ files |
| **Search** | BM25 + TF-IDF | BM25 + vector (384d) |
| **Tool** | `memory_recall` | `memory_search` |

Both can coexist. VDB handles conversation memory; HEKTOR handles enterprise knowledge.

---

*Added in v1.7.0*
