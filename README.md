<div align="center">

# ⚡ Symbiote

**Build AI agents that actually work. Single process. Any machine.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/badge/npm-symbiote--core-red.svg)](https://www.npmjs.com/package/symbiote-core)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey.svg)]()
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![v1.6.0](https://img.shields.io/badge/version-1.6.0-orange.svg)](https://github.com/Artifact-Virtual/symbiote/releases/tag/v1.6.0)

A persistent daemon that connects messaging platforms, LLM providers, and tool execution into a single agentic loop. Real-time interrupts. Seamless continuation. Session-to-session memory. No Docker. No Redis. No cloud dependencies.

**Your machine. Your data. Your keys.**

[Quick Start](#-quick-start) · [Architecture](#-architecture) · [Config](#-configuration) · [Providers](#-providers) · [Tools](#-tools) · [Web UI](#-web-ui)

</div>

---

## 🚀 Quick Start

```bash
# Install
npm install -g symbiote-core

# Interactive setup — generates symbiote.json + .env
symbiote init

# Start the daemon
symbiote start
```

Or from source:

```bash
git clone https://github.com/Artifact-Virtual/symbiote.git
cd symbiote && npm install && npm run build
node dist/gateway/daemon.js --config=symbiote.json
```

> **Windows:** Fully supported. Use `.\symbiote.ps1` or `node dist/gateway/daemon.js --config=symbiote.json`.

<details>
<summary><strong>Manual setup (skip the wizard)</strong></summary>

```bash
cp symbiote.example.json symbiote.json
cp .env.example .env
# Edit both files — set API keys, channel tokens, workspace path, ownerIds
```

</details>

---

## 🏗 Architecture

```
Channels → Router → Message Bus → Agent Runner → LLM Provider
  ↑                      ↑
Discord              Priority Queue
WhatsApp             Coalescing
HTTP API             Interrupts
                     Backpressure
```

| Layer | What it does |
|-------|-------------|
| **Channels** | Discord (discord.js), WhatsApp (Baileys v7), HTTP API. Adapter pattern — add any platform. |
| **Router** | Policy enforcement, JID normalization, deduplication, interrupt detection, priority classification. |
| **Message Bus** | Priority queue with interrupt bypass, message coalescing, backpressure management. |
| **Agent Runner** | Agentic loop — tool calling, context management, abort signals, iteration limits. |
| **Providers** | Groq, Anthropic, OpenAI, Gemini, xAI (Grok), GitHub Copilot, Ollama, Gladius. Hot-swappable mid-session. |
| **Tools** | 18 built-in. File I/O, shell, browser, TTS, memory, process management, messaging. |
| **Sessions** | Persistent, labeled, TTL-aware. Sub-agent spawning up to depth 3. |

---

## 🔥 What Makes Symbiote Different

### Real-Time Interrupts

Most agent frameworks are request-response. You send a message, you wait, you get a reply. Your new message queues silently while the agent is mid-turn. You can't stop it. You can't redirect it.

Symbiote doesn't work that way. Every message is priority-classified in real time:

```
interrupt  →  Bypasses queue. Cancels active turn immediately.
high       →  Skips coalescing. Next in line.
normal     →  Standard processing with coalescing.
low        →  Reactions, group mentions. Queued politely.
background →  Typing indicators. Dropped under backpressure.
```

Say "stop" while the agent is mid-thought — it stops. Not after the current tool call. Not after the current paragraph. **Now.**

### Seamless Continuation (Blink + Pulse)

Most frameworks hard-cap iteration budgets. Hit the wall → session dies → context lost.

**Blink** detects when the agent approaches its budget, spawns a fresh turn on the same session, and carries the full conversation forward. The user sees one continuous interaction. Up to 5 consecutive blinks per task, with periodic checkpoint saves.

**Pulse** adapts the budget itself. Short conversations use 20 iterations. Complex tasks auto-expand to 100. When demand passes, it reverts. Budget carries across restarts.

### Session-to-Session Memory (COMB)

Built into the engine. Zero external dependencies — no Python, no Redis, no database.

- **`comb_stage`** — save critical context for the next session
- **`comb_recall`** — retrieve it when the next session starts
- **Auto-flush** — conversation tail saves automatically on shutdown

If a Python COMB stack exists (enterprise deployments), the native version delegates to it transparently.

### Message Coalescing

Three messages in rapid succession? Symbiote buffers and merges them:

```
"hey"              → buffered
"can you"          → buffered
"check the logs"   → 2s timer expires → one coherent envelope
```

One request, one turn, no wasted tokens.

### One Process, Full Stack

One Node.js daemon runs everything — channels, routing, sessions, tools, providers, web UI. No Docker. No Redis. No Kubernetes. Runs on a $5 VPS or a bare-metal server. CPU-only. If it runs Node.js 20+, it runs Symbiote.

---

## ⚙ Configuration

### `symbiote.json` — Agent configuration

```jsonc
{
  "defaultProvider": "groq",
  "defaultModel": "llama-3.3-70b-versatile",
  "maxTokens": 8192,
  "maxIterations": 25,
  "temperature": 0.3,

  "workspace": "/home/you/workspace",
  "sessionsDir": ".sessions",

  "providers": {
    "groq": { "baseUrl": "https://api.groq.com/openai" },
    "anthropic": {},
    "openai": {},
    "gemini": {},
    "xai": {},
    "ollama": { "baseUrl": "http://127.0.0.1:11434" },
    "github-copilot": {},
    "gladius":        { "baseUrl": "http://127.0.0.1:8741" }
  },

  "ownerIds": [
    "your-discord-user-id",
    "your-phone@s.whatsapp.net"
  ],

  "discord": {
    "enabled": true,
    "token": "${DISCORD_BOT_TOKEN}",
    "botId": "${DISCORD_CLIENT_ID}",
    "policy": {
      "dmPolicy": "allowlist",
      "groupPolicy": "mention-only",
      "allowedSenders": ["your-discord-user-id"]
    }
  },

  "whatsapp": {
    "enabled": true,
    "authDir": "~/.symbiote/whatsapp-auth",
    "phoneNumber": "your-phone-number",
    "policy": {
      "dmPolicy": "allowlist",
      "allowedSenders": ["your-phone@s.whatsapp.net"]
    }
  },

  "apiPort": 3006
}
```

All string values support `${ENV_VAR}` interpolation.

### `.env` — Secrets

```bash
# LLM Providers
GROQ_API_KEY=gsk_...           # https://console.groq.com/keys (free tier)
ANTHROPIC_API_KEY=sk-ant-...   # https://console.anthropic.com/
OPENAI_API_KEY=sk-...          # https://platform.openai.com/api-keys
GEMINI_API_KEY=AIza...         # https://aistudio.google.com/apikey
XAI_API_KEY=xai-...            # https://console.x.ai/

# GitHub Copilot — usually automatic via `gh auth login`
# COPILOT_GITHUB_TOKEN=

# Ollama — no key needed, just run `ollama serve`

# Discord
DISCORD_BOT_TOKEN=
DISCORD_CLIENT_ID=

# HTTP API
MACH6_API_KEY=
MACH6_PORT=3006
```

---

## 🧠 Providers

| Provider | Config Key | How it authenticates | Speed |
|----------|-----------|---------------------|-------|
| **Groq** | `groq` | `GROQ_API_KEY` env var | ⚡ Fastest (LPU hardware) |
| **Anthropic** | `anthropic` | `ANTHROPIC_API_KEY` env var | Fast |
| **OpenAI** | `openai` | `OPENAI_API_KEY` env var | Fast |
| **Gemini** | `gemini` | `GEMINI_API_KEY` env var | Fast |
| **xAI (Grok)** | `xai` | `XAI_API_KEY` env var | Fast |
| **GitHub Copilot** | `github-copilot` | Auto-resolved (see below) — no API key needed | Moderate |
| **Ollama** | `ollama` | Local HTTP endpoint — no key needed | Varies (local) |
| **Gladius** | `gladius` | Local HTTP endpoint | Local |

Providers are hot-swappable mid-session via `/provider` and `/model` commands.

**Recommended for getting started:** Groq — free tier, 280–1000 tok/sec, no credit card. [Get a key →](https://console.groq.com/keys)

### Groq models

| Model | Config value | Notes |
|-------|-------------|-------|
| Llama 3.3 70B | `llama-3.3-70b-versatile` | Best all-around (default) |
| Qwen3 32B | `qwen/qwen3-32b` | Strong reasoning |
| Llama 3.1 8B | `llama-3.1-8b-instant` | Fastest, lighter tasks |

### xAI (Grok) models

| Model | Config value | Notes |
|-------|-------------|-------|
| Grok 3 | `grok-3` | Strongest reasoning |
| Grok 3 Fast | `grok-3-fast` | Lower latency |
| Grok 3 Mini | `grok-3-mini` | Lightweight + think mode |
| Grok 3 Mini Fast | `grok-3-mini-fast` | Fastest Grok |

### Gemini models

| Model | Config value | Notes |
|-------|-------------|-------|
| Gemini 2.5 Pro | `gemini-2.5-pro-preview-05-06` | Strongest reasoning, thinking support |
| Gemini 2.5 Flash | `gemini-2.5-flash-preview-04-17` | Fast + thinking |
| Gemini 2.0 Flash | `gemini-2.0-flash` | Fast, general purpose |
| Gemini 1.5 Pro | `gemini-1.5-pro` | Long context (1M tokens) |

> **Gemini thinking support:** Models with thinking enabled return `thoughtSignature` fields. Symbiote preserves these across tool call roundtrips automatically — required by the Gemini API for thinking-enabled sessions.

### GitHub Copilot token resolution

No API key required if `gh` CLI is installed and authenticated. Token resolves in order:

1. `COPILOT_GITHUB_TOKEN` env var
2. `~/.copilot-cli-access-token` file
3. `GH_TOKEN` / `GITHUB_TOKEN` env vars
4. `~/.config/github-copilot/hosts.json` (Linux/macOS)
5. `%APPDATA%\github-copilot\hosts.json` (Windows)
6. `gh auth token` CLI fallback (all platforms)

### Copilot proxy models

| Model | Config value |
|-------|-------------|
| Grok 3 | `grok-3` |
| Grok 3 Fast | `grok-3-fast` |
| Grok 3 Mini | `grok-3-mini` |

### GitHub Copilot (no API key needed)

Token auto-resolves from `gh auth login`. Proxy models include Claude Opus 4.6, Claude Sonnet 4, GPT-4o, o3-mini.

### Gemini models

| Model | Config value | Notes |
|-------|-------------|-------|
| Gemini 2.0 Flash | `gemini-2.0-flash` | Fast, multimodal (default) |
| Gemini 2.0 Flash Thinking | `gemini-2.0-flash-thinking-exp` | Extended thinking |
| Gemini 1.5 Pro | `gemini-1.5-pro` | Long context (1M tokens) |
| Gemini 1.5 Flash | `gemini-1.5-flash` | Fast, free tier |

### Ollama

```bash
ollama pull qwen3:4b
# Then: defaultProvider: "ollama", defaultModel: "qwen3:4b"
```

---

## 🛠 Tools

18 built-in tools available to every agent:

| Tool | Description |
|------|------------|
| `read` | Read files (offset/limit for large files) |
| `write` | Write/create files |
| `edit` | Surgical find-and-replace editing |
| `exec` | Shell command execution |
| `image` | Vision model image analysis |
| `web_fetch` | Fetch URLs, strip HTML |
| `tts` | Text-to-speech (Edge TTS, 6 voices) |
| `memory_search` | Hybrid BM25 + vector search over indexed files |
| `comb_recall` | Recall persistent memory from last session |
| `comb_stage` | Stage information for next session |
| `message` | Send messages, media, reactions to any channel |
| `typing` | Send typing indicators |
| `presence` | Update presence/status |
| `delete_message` | Delete messages |
| `mark_read` | Send read receipts |
| `process_start` | Start background processes |
| `process_poll` | Poll process output |
| `process_kill` | Kill processes |
| `spawn` | Spawn sub-agents (up to depth 3) |

Tools are sandboxed per-session via the policy engine. MCP bridge available for external tool servers.

---

## 🖥 Web UI

Built-in at `http://localhost:3006`:

- Session management (create, switch, delete)
- Streaming responses with real-time tool call visualization
- Live config panel (provider, model, temperature, API keys)
- Sub-agent monitoring
- Rich rendering for file reads, exec output, fetches

No build step. One static HTML file.

---

## 🖥 CLI

### Interactive REPL

```bash
symbiote repl
# or
node dist/index.js --config=symbiote.json
```

### Commands

| Command | Description |
|---------|------------|
| `/help` | All commands |
| `/tools` | List available tools |
| `/model <name>` | Switch model mid-session |
| `/provider <name>` | Switch provider mid-session |
| `/spawn <task>` | Spawn a sub-agent |
| `/status` | Session stats (tokens, tool usage) |
| `/sessions` | List all sessions |
| `/history [N]` | Last N messages |
| `/clear` | Clear current session |

### One-shot mode

```bash
node dist/index.js "Summarize the README in this directory"
```

---

## 🐧 Running as a Service

### Linux (systemd)

```bash
sudo cp symbiote-gateway.service /etc/systemd/system/
sudo systemctl enable --now symbiote-gateway

# Hot-reload config without restarting:
kill -USR1 $(pgrep -f "gateway/daemon.js")
```

### macOS

LaunchAgent pointing to `node dist/gateway/daemon.js`.

### Windows

NSSM or Task Scheduler with `node dist/gateway/daemon.js --config=symbiote.json`.

---

## 📁 Project Structure

```
symbiote/
├── src/
│   ├── agent/          # Runner, context manager, system prompt builder
│   ├── boot/           # Boot sequence & validation
│   ├── channels/       # Adapters — Discord, WhatsApp, router, bus
│   │   ├── bus.ts      # Priority queue, coalescing, interrupts
│   │   ├── router.ts   # Policy, dedup, JID normalization
│   │   └── adapters/   # discord.js + Baileys v7
│   ├── cli/            # Interactive setup wizard
│   ├── config/         # Config loader, validator, env interpolation
│   ├── cron/           # Cron budget management
│   ├── gateway/        # Persistent daemon — signals, hot-reload, turns
│   ├── heartbeat/      # Activity-aware periodic health checks
│   ├── memory/         # Index integrity checks
│   ├── providers/      # LLM providers — Groq, Anthropic, OpenAI, Gemini, xAI, Copilot, Ollama, Gladius
│   ├── security/       # Input sanitization
│   ├── sessions/       # Session store, queue, sub-agents
│   ├── tools/          # 18+ built-in tools, policy engine, MCP bridge
│   └── web/            # Web UI server (SSE streaming)
├── web/                # Web UI (single HTML file)
├── symbiote.example.json
├── .env.example
└── symbiote-gateway.service
```

---

## 🔒 Production-Ready

20+ hardening decisions baked in:

| Feature | What it does |
|---------|-------------|
| **Blink** | Seamless iteration budget continuation — no hard walls |
| **Pulse** | Adaptive budget: 20 → 100 on demand, auto-reverts |
| **COMB** | Lossless session-to-session memory, zero dependencies |
| **Config validation** | Human-readable diagnostics at boot |
| **Context monitor** | Progressive warnings at 70/80/90% |
| **Priority queue** | Real messages never drop, only background signals shed |
| **Tool policy engine** | Scope tools per session and security tier |
| **Provider diagnostics** | Health checks + automatic failover |
| **Activity-aware heartbeat** | Adapts frequency to user presence |
| **Cron budget management** | Jobs declare resource budgets, scheduler enforces limits |
| **Memory index integrity** | Validates HEKTOR indices at startup, auto-rebuilds if corrupt |
| **Abort propagation** | Agent runner → LLM stream → tool execution |
| **MCP bridge** | Connect external tool servers |
| **MCP server mode** | Expose Symbiote tools to external agents and editors |
| **Sibling bot yield** | @mention one bot, only that one responds |
| **Anti-loop system** | Structural echo loop prevention in multi-bot environments |

---

## 📊 By the Numbers

| | |
|--|--|
| TypeScript source | ~15,000+ lines |
| Source files | 70+ |
| Built-in tools | 18+ |
| LLM providers | 8 |
| Channel adapters | 2 + HTTP API |
| Documentation files | 37 |
| Cold boot → connected | ~2.3s |
| Runtime dependencies | Node.js only |

---

## 🌐 Platform Compatibility

| Feature | Windows | Linux | macOS |
|---------|---------|-------|-------|
| Gateway daemon | ✅ | ✅ | ✅ |
| Discord + WhatsApp | ✅ | ✅ | ✅ |
| HTTP API + Web UI | ✅ | ✅ | ✅ |
| CLI | ✅ | ✅ | ✅ |
| Hot-reload (SIGUSR1) | ❌ | ✅ | ✅ |

---

## 📜 Changelog

| Date | Milestone |
|------|----------|
| **Feb 22, 2026** | Built from scratch. WhatsApp, Discord, gateway, config, tools, sessions. |
| **Feb 22, 2026** | 14/14 smoke tests. 20 hardening fixes. Flipped to production same day. |
| **Feb 23, 2026** | Open-sourced. MIT license. |
| **Feb 28, 2026** | Cross-platform (Windows/Linux/macOS). CLI wizard. v1.0.0. |
| **Mar 3, 2026** | Multi-bot coordination, ATM, sibling yield. v1.3.0. |
| **Mar 5, 2026** | MCP server, anti-loop, degradation protection. v1.4.0. |
| **Mar 6, 2026** | Blink, Pulse, COMB, 7 providers, agent wizard. v1.5.0. |
| **Mar 7, 2026** | Native Gemini provider, 8 providers, multi-user deployment. v1.6.0. |

---

## 📄 License

[MIT](LICENSE) — do whatever you want with it.

---

<div align="center">

Built by **[Artifact Virtual](https://artifactvirtual.com)**

---

`#ai-agent` `#llm-agent` `#autonomous-agent` `#tool-calling` `#agentic-ai`
`#discord-bot` `#whatsapp-bot` `#multi-channel` `#chatbot-framework`
`#groq` `#anthropic` `#claude` `#openai` `#gpt4` `#grok` `#xai`
`#ollama` `#local-llm` `#github-copilot` `#mcp` `#model-context-protocol`
`#typescript` `#nodejs` `#self-hosted` `#open-source` `#local-first`

</div>
