# COMB — Native Memory Persistence

Lossless session-to-session memory. Pure Node.js, zero external dependencies. Works for any agent on any platform.

## What It Does

COMB gives agents persistent memory across sessions. When a session ends, critical context is staged. When the next session starts, it's recalled. No information loss between restarts.

Two tools are available to agents:

| Tool | Description |
|------|-------------|
| `comb_recall` | Recall staged memories from previous sessions |
| `comb_stage` | Stage information for the next session |

## Architecture

```
workspace/.comb/
├── staging/         # Today's staged entries (one JSON per day)
├── archive/         # Rolled-up permanent documents (one JSON per day)
└── state.json       # Metadata (last rollup, entry count)
```

### Staging

Each `comb_stage` call appends an entry with text, timestamp, and source tag. Entries accumulate in daily JSON files. When a day gets more than 10 entries, COMB auto-rolls them into an archive document.

### Archive

Rolled-up entries are formatted with timestamps and stored permanently. Archive files are compact — one JSON per day containing all rolled-up content.

### Recall

`comb_recall` returns recent context from:

1. **Staging** — today's and yesterday's unrolled entries (last 8)
2. **Archive** — today's and yesterday's rolled documents (latest per day)
3. **Auto-cleanup** — staging files older than yesterday are auto-rolled during recall

## Python COMB Fallback

If a Python COMB installation exists in the workspace (`.hektor-env/bin/python3` + `.ava-memory/flush.py`), the native tools delegate to the Python version, which offers richer features: BM25 search, chain integrity, HEKTOR integration.

If the Python stack isn't available (or fails), native COMB kicks in seamlessly. This makes COMB work everywhere — from a bare `npm install` to a full enterprise deployment.

## Session Auto-Flush

When a session ends, the daemon calls `flushMessages()` to automatically stage the last 4 conversation messages into COMB. This ensures that even if the agent didn't explicitly call `comb_stage`, critical context from the conversation tail is preserved.

## Configuration

COMB works out of the box with zero configuration. The `.comb/` directory is created automatically in the agent's workspace on first use.

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
