<div align="center">

# SYMBIOTE
> APEX

**Build persistent AI agents. Single process. Any machine.**

![](https://img.shields.io/badge/Version-3.0.0-4B0082?style=for-the-badge&labelColor=0D1117&logo=git&logoColor=white)
![](https://img.shields.io/badge/Tools-38-4B0082?style=for-the-badge&labelColor=0D1117&logo=hammer&logoColor=white)
![](https://img.shields.io/badge/Providers-8-4B0082?style=for-the-badge&labelColor=0D1117&logo=openai&logoColor=white)
![](https://img.shields.io/badge/TypeScript-18K_LOC-4B0082?style=for-the-badge&labelColor=0D1117&logo=typescript&logoColor=white)
<br>
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge&labelColor=0D1117)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-green.svg?style=for-the-badge&labelColor=0D1117&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/Windows%20%7C%20Linux%20%7C%20macOS-lightgrey?style=for-the-badge&labelColor=0D1117&logo=windows&logoColor=white)]()

A persistent daemon that connects messaging platforms, LLM providers, and tool execution into a single agentic loop. Embedded persistent memory. Real-time interrupts. Full web automation. Voice pipeline. Session-to-session continuity.

**No Docker. No Redis. No cloud dependencies. Your machine. Your data. Your keys.**

[Quick Start](#-quick-start) · [Architecture](#-architecture) · [Memory](#-persistent-memory) · [Providers](#-providers) · [Tools](#-tools) · [Web UI](#-web-ui)

</div>

---

## Overview

Symbiote is a framework for building AI agents that persist — across conversations, across sessions, across restarts. Where most agent frameworks treat each conversation as disposable, Symbiote treats every interaction as part of a continuous memory that compounds over time.

A single TypeScript process handles messaging (WhatsApp, Discord), LLM routing (8 providers), tool execution (38 tools), persistent memory (embedded VDB), voice (TTS/STT), web automation (Playwright), and session management — with zero external infrastructure.

---

## Quick Start

```bash
# Install
npm install -g symbiote

# Interactive setup — generates mach6.json + .env
mach6 init

# Start the daemon
mach6 start
```

Or from source:

```bash
git clone https://github.com/Artifact-Virtual/Symbiote.git
cd Symbiote && npm install && npm run build
node dist/gateway/daemon.js --config=mach6.json
```

> **Windows:** Fully supported. Use `.\install.ps1` for automated setup or `node dist/gateway/daemon.js --config=mach6.json`.

---

## Architecture

```
Channels → Router → Message Bus → Agent Runner → LLM Provider
  ↑                     ↑              ↑              ↑
Discord            Priority Queue   Context Store   Anthropic
WhatsApp           Coalescing       VDB Memory      OpenAI
HTTP API           Interrupts       COMB Staging    Gemini
Web UI             Backpressure     Voice Pipeline  Groq / xAI / Ollama
```

| Layer | What It Does |
|-------|-------------|
| **Channels** | WhatsApp (Baileys), Discord (discord.js), HTTP API, Web UI — all bidirectional with typing indicators, reactions, read receipts, media |
| **Message Bus** | Priority queue with interrupt coalescing. New messages preempt stale iterations. Backpressure prevents queue flooding |
| **Sessions** | Per-chat conversation state with automatic archival. Sub-agent spawning for parallel work. Configurable budgets |
| **Agent Runner** | The agentic loop — assembles context, calls LLM, executes tools, manages iterations. Handles blink (budget refresh) and pulse (heartbeat scheduling) |
| **Context Store** | Bridge between attention and memory. Truncated messages get absorbed into VDB. Every iteration queries VDB for relevant prior context. Nothing is ever truly lost |
| **Context Monitor** | Three-threshold compaction (70/80/90% capacity). Emergency flush on critical. Auto-stages to COMB before compaction |
| **VDB** | Embedded persistent memory — BM25 + TF-IDF hybrid search. Zero dependencies. JSONL append-only storage. 10-second real-time pulse indexes new messages incrementally |
| **COMB** | Session-to-session staging. The agent's explicit "remember this" mechanism. Now a pure VDB wrapper — no file storage, no Python, no IPC |
| **Voice** | Inbound: auto-transcribe voice notes (faster-whisper STT). Outbound: generate voice replies (Edge TTS, 6 voices). Platform-native delivery |
| **Providers** | 8 LLM backends with automatic failover, retry with backoff, streaming support. Model-agnostic tool calling |
| **Tools** | 38 built-in tools: filesystem, shell, web automation, messaging, memory, process management, vision, TTS |
| **IPC Identity** | HMAC-SHA256 signed inter-agent communication. Agents verify each other cryptographically |
| **Security** | Input sanitization, prompt injection guards, tool policy engine, configurable whitelists |

---

## Persistent Memory

The core innovation. Three layers work together so agents never lose context:

### VDB — Embedded Vector Database

Zero-dependency persistent memory built into the runtime.

- **Hybrid search:** BM25 keyword matching (40%) + TF-IDF sparse vectors with cosine similarity (60%)
- **Storage:** JSONL append-only files. Lazy load on first query. Idle eviction after 5 minutes
- **Real-time pulse:** Every 10 seconds, indexes new messages from active sessions. Only human/assistant turns above 15 chars — tool noise is excluded
- **Session archives:** Completed sessions get auto-ingested. Nothing vanishes when a conversation ends
- **Queried every iteration:** Before each LLM call, the Context Store pulls relevant prior knowledge from VDB and injects it after the system prompt

```typescript
// The agent sees this automatically — no manual search needed
[RETRIEVED CONTEXT — relevant prior knowledge from your memory]:
  [whatsapp, 3h ago, relevance=89%] Discussion about API architecture...
  [discord, 2d ago, relevance=72%] Decision to use HMAC for IPC...
```

### COMB — Session-to-Session Memory

The agent's explicit staging mechanism. Two tools:

- `comb_stage` — "Remember this for next session." Writes to VDB with `comb` source tag
- `comb_recall` — "What did I stage?" Retrieves all COMB entries, most recent first

COMB is now a pure VDB wrapper. No file storage, no Python process, no IPC protocol. Stage → VDB → searchable forever.

### Context Store — The Bridge

When `truncateContext` drops old messages to fit the token budget, the Context Store absorbs them into VDB. On every iteration, it queries VDB with recent conversation context and injects relevant prior knowledge. The context window becomes a sliding viewport over persistent memory.

---

## Providers

8 LLM backends. Automatic failover chain — if provider A fails, try B, then C.

| Provider | Models | Notes |
|----------|--------|-------|
| **Anthropic** | Claude 4 Sonnet, Opus, Haiku | Primary. Full tool use, streaming |
| **OpenAI** | GPT-4o, GPT-4, o1 | Full tool use, streaming |
| **Google Gemini** | Gemini 2.5 Pro/Flash | Native tool calling |
| **Groq** | Llama, Mixtral, Gemma | Fast inference. Free tier |
| **xAI** | Grok | Tool use support |
| **GitHub Copilot** | GPT-4o via Copilot | Free with GitHub account |
| **Ollama** | Any GGUF model | Local, private, offline |
| **GLADIUS** | Custom architecture | Artifact Virtual's native model |

Configure failover chains in `mach6.json`:

```json
{
  "providers": [
    { "type": "anthropic", "model": "claude-sonnet-4-20250514" },
    { "type": "openai", "model": "gpt-4o", "fallback": true },
    { "type": "ollama", "model": "llama3.1:8b", "fallback": true }
  ]
}
```

---

## Tools

38 built-in tools across 8 categories:

### Filesystem
| Tool | Description |
|------|-------------|
| `read` | Read file contents with optional offset/limit for large files |
| `write` | Write content to file. Creates parent directories automatically |
| `edit` | Surgical text replacement — find exact string, replace it |

### Shell & Processes
| Tool | Description |
|------|-------------|
| `exec` | Execute shell commands with timeout, working directory, PTY support |
| `process_start` | Start background processes. Returns handle for polling |
| `process_poll` | Poll background process for new output |
| `process_kill` | Kill a background process |
| `process_list` | List all background processes |

### Web Automation (Playwright)
| Tool | Description |
|------|-------------|
| `web_browse` | Navigate to URL, return text + screenshot |
| `web_click` | Click elements by CSS selector or text content |
| `web_type` | Type into input fields |
| `web_screenshot` | Capture viewport or full page |
| `web_extract` | Extract text from specific CSS selectors |
| `web_scroll` | Scroll up, down, or to specific elements |
| `web_wait` | Wait for elements or navigation |
| `web_session` | Switch browser profiles (isolated cookies/storage) |
| `web_tab_open` | Open new browser tabs |
| `web_tab_switch` | Switch between tabs |
| `web_tab_close` | Close current tab |
| `web_tabs` | List all open tabs |
| `web_download` | Download files from pages or URLs |
| `web_upload` | Upload files to file input elements |
| `web_fetch` | Fetch URL content as plain text (strips HTML) |

### Messaging
| Tool | Description |
|------|-------------|
| `message` | Send messages, media, reactions across WhatsApp/Discord |
| `typing` | Send typing indicators |
| `presence` | Update online/offline status |
| `delete_message` | Delete messages |
| `mark_read` | Send read receipts |

### Memory
| Tool | Description |
|------|-------------|
| `memory_search` | Hybrid search across all indexed memory (HEKTOR) |
| `memory_recall` | Search persistent memory with source filtering |
| `memory_ingest` | Ingest conversation history into persistent memory |
| `memory_stats` | Show memory database statistics |
| `comb_recall` | Retrieve staged session-to-session memories |
| `comb_stage` | Stage information for the next session |

### Agents
| Tool | Description |
|------|-------------|
| `spawn` | Spawn sub-agents for parallel background tasks |
| `subagent_status` | Check, list, kill, or steer sub-agents |

### Media
| Tool | Description |
|------|-------------|
| `image` | Analyze images with vision models (local files or URLs) |
| `tts` | Text-to-speech with 6 voices (Edge TTS, free) |

---

## Web UI

Built-in chat interface at `http://localhost:{webPort}`. Dark glass aesthetic. Features:

- Real-time streaming responses via Server-Sent Events
- Tool call visualization — see what the agent is doing
- Session management with configurable IDs
- File upload support
- Mobile responsive
- Bound to localhost by default (configurable via `webHost`)

---

## Channels

### WhatsApp
Full-featured WhatsApp integration via Baileys:
- Text, images, audio, video, documents, stickers
- Voice note transcription (automatic STT)
- Read receipts, typing indicators, presence
- Reactions and replies
- Group chat support
- QR code authentication

### Discord
Complete Discord bot integration:
- Text channels and DMs
- Embeds, reactions, mentions
- Voice channel awareness
- Slash commands (optional)
- Multi-guild support

### HTTP API
RESTful API for programmatic access:
- `POST /api/v1/chat` — send messages
- `GET /api/v1/sessions` — list sessions
- Server-Sent Events for streaming
- IPC identity verification (HMAC-SHA256)

---

## Configuration

All configuration lives in `mach6.json`:

```json
{
  "name": "my-agent",
  "provider": {
    "type": "anthropic",
    "model": "claude-sonnet-4-20250514"
  },
  "channels": {
    "whatsapp": { "enabled": true },
    "discord": { "enabled": true, "token": "..." }
  },
  "tools": {
    "enabled": ["read", "write", "exec", "web_browse", "memory_recall"],
    "disabled": []
  },
  "sessions": {
    "maxIterations": 50,
    "maxTokens": 200000
  },
  "webPort": 3000,
  "cron": {
    "heartbeat": "*/15 * * * *"
  }
}
```

Secrets go in `.env`:

```bash
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
DISCORD_TOKEN=...
```

Run `mach6 init` to generate both interactively.

---

## Agentic Features

### Blink — Budget Refresh
When an agent approaches its iteration limit, Blink seamlessly continues into a fresh budget. The conversation carries over. The user sees nothing. No "[Budget exhausted]" messages.

### Pulse — Heartbeat Scheduling
Periodic heartbeats fire on a cron schedule. Agents use these for batch health checks, monitoring, proactive updates — anything that should happen on a schedule without human prompting.

### Context Monitor — Adaptive Compaction
Three thresholds (70/80/90%) manage context window pressure:
- **70%**: Summary compaction of older messages
- **80%**: Aggressive compaction with COMB auto-staging
- **90%**: Emergency flush — stage everything critical, compact hard

### Sub-Agents — Parallel Execution
Spawn background workers for long-running tasks. The main agent continues conversing while sub-agents research, build, monitor. Up to 3 levels of nesting.

### Temperature Adaptation
Dynamic temperature adjustment based on task type — lower for code/analysis, higher for creative work. Automatic detection from context.

---

## IPC Identity

Agents can verify each other's identity when communicating:

```typescript
// Agent A signs its request
headers: {
  'ipc-agent-id': 'ava',
  'ipc-signature': hmacSha256(body, sharedSecret)
}

// Agent B verifies
if (verifySignature(body, signature, sharedSecret)) {
  // Trusted inter-agent communication
}
```

Keyring-based. Each agent has a unique ID and shared secret. Non-IPC requests (human users) pass through unaffected.

---

## Installation

### One-command install

```bash
# Linux/macOS
curl -fsSL https://raw.githubusercontent.com/Artifact-Virtual/Symbiote/master/install.sh | bash

# Windows (PowerShell)
irm https://raw.githubusercontent.com/Artifact-Virtual/Symbiote/master/install.ps1 | iex
```

### From source

```bash
git clone https://github.com/Artifact-Virtual/Symbiote.git
cd Symbiote
npm install
npm run build
cp mach6.example.json mach6.json
cp .env.example .env
# Edit mach6.json and .env with your keys
node dist/gateway/daemon.js --config=mach6.json
```

### systemd service

```bash
cp mach6-gateway.service ~/.config/systemd/user/
systemctl --user enable --now mach6-gateway
```

---

## Project Structure

```
src/
├── agent/           # Runner, context management, blink, pulse
│   ├── runner.ts          # The agentic loop
│   ├── context-store.ts   # VDB retrieval + absorption bridge
│   ├── context-monitor.ts # Token budget management
│   ├── blink.ts           # Seamless budget refresh
│   └── pulse.ts           # Heartbeat scheduler
├── channels/        # WhatsApp, Discord, HTTP adapters
├── config/          # Configuration loading + validation
├── gateway/         # Daemon entry point
├── memory/          # VDB engine + integrity checks
├── providers/       # 8 LLM provider implementations
├── sessions/        # Session manager, sub-agents, queue
├── security/        # Sanitizer, prompt guards
├── tools/           # 38 built-in tools + MCP bridge
│   └── builtin/     # All tool implementations
├── voice/           # STT/TTS pipeline
└── web/             # HTTP API + Web UI
```

---

## Requirements

- **Node.js** 20+ (LTS recommended)
- **npm** 9+
- **OS:** Windows, Linux, or macOS
- At least one LLM provider API key (or Ollama for fully local)

Optional:
- **Playwright** (auto-installed on first `web_browse` call)
- **faster-whisper** (for voice note transcription)
- **edge-tts** (for text-to-speech, pip install)

---

## License

MIT — see [LICENSE](LICENSE)

---

<div align="center">

**Built by [Artifact Virtual](https://github.com/Artifact-Virtual)**
> commit.

</div>
