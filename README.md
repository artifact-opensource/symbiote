<div align="center">

# Symbiote

**Persistent AI agent runtime for your workspace.**

v4.0.0 · Node.js 20+ · TypeScript · MIT

[Quick start](#quick-start) · [Configuration](#configuration) · [Memory](#memory) · [CLI](#cli)

</div>

---

## What It Is

Symbiote runs an LLM agent in a persistent local process. It connects configured providers and messaging channels to a tool-enabled agent loop, stores sessions on disk, and provides an embedded memory index.

The runtime does not require Docker, Redis, or an external vector database. Provider APIs and optional channel services still require their own credentials and network access.

## Quick Start

**Requirements:** Node.js 20 or newer.

```bash
git clone https://github.com/Artifact-Virtual/symbiote.git
cd symbiote
npm install
npm run build
```

Initialize configuration and start the interactive agent:

```bash
node dist/index.js init
node dist/index.js
```

To start the persistent gateway instead:

```bash
node dist/index.js start
node dist/index.js status
```

The setup flow creates `symbiote.json` and `.env`. Keep API keys and channel tokens in `.env`; do not commit them.

## Configuration

A minimal `symbiote.json`:

```json
{
  "defaultProvider": "openrouter",
  "defaultModel": "openrouter/free",
  "workspace": ".",
  "providers": {
    "openrouter": {
      "apiKey": "${OPENROUTER_API_KEY}",
      "baseUrl": "https://openrouter.ai/api/v1"
    }
  },
  "maxTokens": 8192,
  "maxIterations": 50,
  "timeouts": {
    "llmRequestMs": 900000
  }
}
```

The default LLM request timeout is 15 minutes. `timeouts.llmRequestMs` and provider-specific `timeoutMs` values can override it. Provider retries preserve the configured timeout; authentication failures fail fast.

The CLI and gateway currently register OpenRouter, Anthropic, OpenAI, Groq, Gemini, NVIDIA, xAI, GitHub Copilot, Ollama, and Gladius. Qwen, AI Horde, FreeAI, and OmniRoute provider modules exist but are not selectable through the default registries. A routed provider is used only when it is registered and configured; otherwise Symbiote uses the configured default provider.

## Memory

### Embedded VDB

The native VDB is stored under `<workspace>/.vdb`. It persists JSONL documents and builds BM25 plus sparse TF-IDF indexes for hybrid lexical retrieval. Sessions are indexed incrementally; `memory_recall`, `memory_ingest`, and `memory_stats` are available in the gateway, CLI tool registry, and MCP server.

This implementation does not generate dense neural embeddings. Its similarity ranking is based on lexical BM25/TF-IDF signals, recency, and optional Memograph metadata.

### Memograph

Memograph snapshots can be imported into the VDB from `MEMOGRAPH_STORAGE_DIR`. By default, Symbiote looks for a sibling `memograph/.memograph_storage` directory. Each shard is imported as its own document with graph, domain, scope, permission, version, content type, parent, and relation metadata preserved. LIVE, PROJECT, and ENTERPRISE memories use separate namespaces.

See [Memograph Integration](docs/core/memograph.md) for storage discovery, permission filtering, diagnostics, and retrieval limits.

Context retrieval filters Memograph shards by the `agent` or wildcard permission, applies domain authority and scope affinity, and can expand a bounded number of related shards. Import errors identify the snapshot or shard and do not stop healthy records from loading. Symbiote reads Memograph snapshots; it does not require the Python package at runtime.

Use the VDB maintenance command to inspect or refresh memory:

```bash
node dist/cli/vdb-maintenance.js stats
node dist/cli/vdb-maintenance.js ingest
node dist/cli/vdb-maintenance.js stage "Remember this for the next session"
```

## Channels And Tools

The gateway can connect configured Discord and WhatsApp adapters and expose an HTTP API. Channel access policies and owner IDs are configured in `symbiote.json`.

Built-in tools cover file reading/writing/editing, shell and background process management, web fetching and browsing, image analysis, messaging, sub-agents, speech, persistent memory, and session continuity. The CLI and gateway display the actual number of tools registered for that process; the set can differ when tools or channels are disabled.

Agent tool calls run with bounded concurrency. Long tasks can continue across iteration budgets, and completion is reviewed before the runner accepts a final answer. Discord input queued during an active turn is processed in order.

## CLI

```bash
node dist/index.js                 # interactive REPL
node dist/index.js "Summarize this" # one-shot prompt
node dist/index.js help
node dist/index.js status
```

REPL commands include `/help`, `/tools`, `/history`, `/model`, `/provider`, `/spawn`, `/status`, `/sessions`, `/clear`, and `/quit`. The prompt shows cumulative provider-reported token usage for the active session. Usage is cumulative billing usage, not the current context-window size.

## Development

```bash
npm run build
node --test dist/test/*.test.js
```

The project includes focused tests for provider routing, continuation behavior, VDB-backed Memograph import, tool execution, and session memory. Provider and channel integrations should also be exercised with their configured test credentials before deployment.

## Documentation

Additional guides live in [`docs/`](docs/README.md). Start with [Quick Start](docs/getting-started/quick-start.md), [Configuration](docs/getting-started/configuration.md), and [Built-in Tools](docs/tools/built-in.md).

## License

[MIT](LICENSE)
