<div align="center">

<img src="assets/biohazard_white.ico" alt="Symbiote logo" width="64" height="64">

# SYMBIOTE

**Persistent AI agent runtime for any type of workspace.**

[![Version](https://img.shields.io/badge/version-5.7.1-blue?style=flat-square)](https://github.com/artifact-opensource/symbiote/releases)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9.3-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![MIT License](https://img.shields.io/badge/license-MIT-yellow?style=flat-square)](LICENSE) <br>


[Features](#persistent-intelligent-and-built-for-real-work) · [Quick start](#quick-start) · [Configuration](#configuration) · [Memory](#memory) · [CLI](#cli)

</div>

---

## Persistent, Intelligent, And Built For Real Work

Symbiote is more than a chat interface around an LLM. It is a local-first agent runtime designed to stay present in your workspace, use real tools, retain useful context, and recover cleanly as work spans turns and restarts.

| Capability | What it gives you |
|---|---|
| **A persistent agent** | A gateway process connects your channels, preserves session state on disk, resumes eligible conversations after restarts, and keeps long-running work moving across iteration budgets. |
| **Memory with provenance and boundaries** | Embedded lexical retrieval, durable sessions, COMB continuity, and optional Memograph imports work together. A separate bounded Ops Memory records only coarse metadata about completed tool calls; it expires observations and labels them as historical evidence, never live status. |
| **A tool-using runtime** | Built-in file, filesystem, shell, process, browser, web, hardware, memory, messaging, and sub-agent tools let the agent inspect and act in its configured environment. Tool execution is sequential within an iteration, results are checked, and failures are returned to the agent to guide a different approach. |
| **Adaptive and self-evaluating behavior** | SARSI, PARC, Curator, MEA, and Meta^n support routing, outcome assessment, and controlled evaluation of proposed improvements without inserting extra model calls into the tool-execution loop. |
| **Channels and interfaces** | Run interactively in the CLI or keep the gateway online for Discord, WhatsApp, and the local HTTP/web interface. The optional Electron desktop shell connects to that same Gateway and Control Room. Channel-specific formatting, queued input, steering, and interrupt handling keep the interaction usable during long tasks. |
| **Native Git** | A built-in Git tool runs through the installed Git CLI, using local SSH and credential helpers for any standard remote. Configure the commit name and email in Integrations; only one generic Git shortcut appears on the overview. |
| **Application connectors** | A common connector engine supports REST and MCP adapters, encrypted credentials, explicit per-agent capability grants, connection health, and bounded execution history. Built-in connectors cover GitHub, GitLab, Gitee, Bitbucket Cloud, Codeberg, Notion, Slack, Figma, and Canva. |
| **Markets workspace** | Public market feeds, persistent chart drawings and indicators, agent-accessible chart tools, a dedicated chat, and an optional MetaTrader 5 bridge. |
| **Independent recovery surface** | The gateway also serves a standalone, dependency-free native UI at `/native` and supervises its HTTP server with bounded exponential restart retries. |
| **Local-first and portable** | Sessions, configuration, and memory live on disk in your workspace. No Docker, Redis, or external vector database is required. Providers and channel services still need their own credentials and network access. |

The runtime exposes the actual tools configured for each process. Access is governed by the configured trust and sandbox policy; admin access can reach the host machine, so only run it with credentials and permissions appropriate to your deployment. Browser CUA tools control only the Playwright viewport; the separate native `computer_use` runtime controls the host desktop and is restricted to admin sessions. Desktop screenshots are sent to the configured model for visual reasoning.

---

## What It Is

Symbiote runs an LLM agent in a persistent local process. It connects configured providers and messaging channels to a tool-enabled agent loop, stores sessions on disk, and provides an embedded memory index.

The runtime does not require Docker, Redis, or an external vector database. 
Provider APIs and optional channel services require their own credentials and network access.

## Screenshots

<details>
  <summary>Webapp — desktop and mobile</summary>
  <p align="center">
    <img src="docs/screenshots/webapp-desktop.png" alt="Symbiote Control Room on desktop" width="720">
    <img src="docs/screenshots/webapp-mobile.png" alt="Symbiote Control Room on mobile" width="220">
  </p>
</details>

<details>
  <summary>Native recovery UI — desktop and mobile</summary>
  <p align="center">
    <img src="docs/screenshots/native-web-ui-desktop.png" alt="Symbiote native recovery UI on desktop" width="720">
    <img src="docs/screenshots/native-web-ui-mobile.png" alt="Symbiote native recovery UI on mobile" width="220">
  </p>
</details>

<details>
  <summary>CLI — desktop and mobile-sized terminal</summary>
  <p align="center">
    <img src="docs/screenshots/cli-desktop.png" alt="Symbiote CLI on desktop" width="720">
    <img src="docs/screenshots/cli-mobile.png" alt="Symbiote CLI in a mobile-sized terminal" width="220">
  </p>
</details>

## Quick Start

**Requirements:** Node.js 20 or newer.

```bash
git clone https://github.com/artifact-opensource/symbiote.git
cd symbiote
npm ci
npm --prefix webapp ci
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

The gateway serves the full workspace at `http://127.0.0.1:3009/` and its standalone recovery UI at `http://127.0.0.1:3009/native`. The native page is an independent HTML/CSS/JavaScript document and remains available when the bundled webapp cannot load.

The setup flow creates `symbiote.json` (with a JSON Schema for editor support) and `.env`. Keep API keys and channel tokens in `.env`; config files reference them as `${VAR}`. Upgrading from an older version? Run `node dist/index.js upgrade`.

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

The CLI and gateway register OpenRouter, Anthropic, OpenAI, Groq, Gemini, NVIDIA, xAI, GitHub Copilot, Ollama, Artifact Engine, Gladius, FreeAI, and Cloudflare Workers AI. A routed provider is used only when it is registered and configured; otherwise Symbiote uses the configured default provider. Supported providers can expose models through automatic discovery, including account-scoped Cloudflare model discovery.

Providers can set `contextWindow` and `maxTokens` independently. When a context window is configured, the runner trims older conversation history to leave room for the requested output and tool definitions. Set these values to the limits supported by the selected model and account; see the [Cloudflare setup guide](docs/providers/cloudflare.md) for a concrete example.

## Memory

### Embedded VDB

The native VDB is stored under `<workspace>/.vdb`. It persists JSONL documents and builds BM25 plus sparse TF-IDF indexes for hybrid lexical retrieval. Sessions are indexed incrementally; `memory_recall`, `memory_ingest`, and `memory_stats` are available in the gateway, CLI tool registry, and MCP server.

The default VDB retrieval uses lexical BM25/TF-IDF signals, recency, and optional Memograph metadata. Optional neural memory adds dense retrieval through Ollama or Artifact Engine embeddings and a persistent HNSW index, while preserving the original VDB records and lexical fallback. Artifact Engine must have an embedding-capable GGUF model loaded; it serves pooled final-layer hidden states through its OpenAI-compatible `/v1/embeddings` endpoint. See [Optional neural memory](docs/getting-started/configuration.md#optional-neural-memory).

### Operational continuity

Ops Memory is a separate, bounded store under `<workspace>/.symbiote/ops-memory.json`. After delivery, it records only coarse metadata about supported completed tool executions—not commands, arguments, output bodies, or user text. Records are workspace-scoped, deduplicated, capped, and expire according to how quickly the observed category can change. Retrieval is limited to relevant operational questions and clearly warns that historical evidence must not be treated as current state. Set `SYMBIOTE_OPS_MEMORY=0` to disable it.

### Memograph

Memograph snapshots can be imported into the VDB from `MEMOGRAPH_STORAGE_DIR`. By default, Symbiote looks for a sibling `memograph/.memograph_storage` directory. Each shard is imported as its own document with graph, domain, scope, permission, version, content type, parent, and relation metadata preserved. LIVE, PROJECT, and ENTERPRISE memories use separate namespaces.

See [Memograph Integration](docs/core-conepts/memograph.md) for storage discovery, permission filtering, diagnostics, and retrieval limits.

Context retrieval filters Memograph shards by the `agent` or wildcard permission, applies domain authority and scope affinity, and can expand a bounded number of related shards. Import errors identify the snapshot or shard and do not stop healthy records from loading. Symbiote reads Memograph snapshots; it does not require the Python package at runtime.

Use the VDB maintenance command to inspect or refresh memory:

```bash
node dist/cli/vdb-maintenance.js stats
node dist/cli/vdb-maintenance.js ingest
node dist/cli/vdb-maintenance.js stage "Remember this for the next session"
```

## Channels And Tools

The gateway can connect configured Discord and WhatsApp adapters and expose an HTTP API. Channel access policies and owner IDs are configured in `symbiote.json`.

Built-in tools cover file reading, writing, editing and filesystem management (`fs`), hardware inspection (`hardware`), shell and background process management, web fetching/browsing, native browser CUA (viewport screenshot, coordinate pointer, keyboard, and scroll), full native desktop control, image analysis, messaging, sub-agents, speech, persistent memory, and session continuity. Access follows the configured trust and sandbox policy; review [Security](docs/advanced/security.md) before exposing an instance to other users. On Windows, `exec` runs PowerShell by default and routes POSIX-style commands (`ls -la`, `grep`, `&&`) to Git Bash when installed. Commands start in the configured working directory unless `workdir` is passed; do not assume Linux paths on Windows. Use `shell` to force a shell. The CLI and gateway display the actual number of tools registered for that process; the set can differ when tools or channels are disabled.

Agent tool calls run with bounded concurrency. Long tasks can continue across iteration budgets, and completion is reviewed before the runner accepts a final answer. Discord input queued during an active turn is processed in order.

## CLI

```bash
symbiote                    # interactive agent (REPL)
symbiote agent "Summarize"  # one-shot prompt
symbiote start | stop | restart | status | logs [-f]
symbiote init [--ui]        # guided setup (terminal or browser)
symbiote configure          # edit common settings
symbiote upgrade            # migrate symbiote.json to the current format
symbiote help
```

Output is quiet by default. Set `SYMBIOTE_LOG=debug` to show internal subsystem logs.

REPL commands include `/help`, `/tools`, `/history`, `/model`, `/provider`, `/spawn`, `/status`, `/sessions`, `/clear`, and `/quit`. During an active turn, plain text or `/queue <text>` queues the next message; `/steer <text>` cancels the current request and resumes with new guidance; `/interrupt` stops the turn and saves partial state. The prompt shows cumulative provider-reported token usage for the active session, not current context size.

## Development

```bash
npm ci
npm --prefix webapp ci
npm run typecheck
npm run build
npm test
npm run check:release
```

The project includes focused tests for provider routing, continuation behavior, VDB-backed Memograph import, tool execution and result handling, operational-memory expiry and retrieval, Discord progress formatting, and session persistence. Provider and channel integrations should also be exercised with their configured test credentials before deployment.
Pull requests and branch pushes run [CI](.github/workflows/ci.yml). Dependabot proposes weekly dependency and workflow updates; repository issue labels are maintained in [`.github/labels.json`](.github/labels.json) and can be synchronized with the [label workflow](.github/workflows/sync-labels.yml).

## Contributing and community

Contributions are welcome. Please read the [contribution guidelines](.github/CONTRIBUTING.md) and follow the [Code of Conduct](.github/CODE_OF_CONDUCT.md). For vulnerability reports, use the private process in [SECURITY.md](SECURITY.md).

## Documentation

Additional guides live in [`docs/`](docs/README.md). Start with [Quick Start](docs/getting-started/quick-start.md), [Configuration](docs/getting-started/configuration.md), [Built-in Tools](docs/tools/built-in.md), and the [full changelog](CHANGELOG.md). Current release details are in [Release Notes](docs/releases/RELEASE_NOTES_v5.7.1.md).

## License

[MIT](LICENSE)

---

[![CI](https://github.com/artifact-opensource/symbiote/actions/workflows/ci.yml/badge.svg)](https://github.com/artifact-opensource/symbiote/actions/workflows/ci.yml) <br>
[![Build and release assets](https://github.com/artifact-opensource/symbiote/actions/workflows/release.yml/badge.svg)](https://github.com/artifact-opensource/symbiote/actions/workflows/release.yml)
