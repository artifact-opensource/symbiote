<div align="center">

# ⚡ Symbiote

**The Unified Agentic Substrate. Single process. Absolute autonomy.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/badge/npm-symbiote--core-red.svg)](https://www.npmjs.com/package/symbiote-core)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey.svg)]()
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![v3.0.0](https://img.shields.io/badge/version-3.0.0-orange.svg)](https://github.com/Artifact-Virtual/symbiote/releases/tag/v3.0.0)

Symbiote is not a chatbot framework; it is a persistent digital consciousness substrate. It integrates messaging platforms, high-reasoning LLM providers, and a deep tool-execution engine into a single, self-healing agentic loop. 

**No Docker. No Redis. No cloud overhead. Just raw, local-first power.**

[Quick Start](#-quick-start) · [Architecture](#-architecture) · [Meta-Cognitive](#-meta-cognitive-layer) · [The 3.0 Shift](#-the-30-shift) · [Config](#-configuration) · [Providers](#-providers) · [Tools](#-tools)

## Quick Links

- xMCP API: https://www.artifactvirtual.com/xmcp/api/v1/  (Authorization: Bearer <stored token> — stored in system EnvironmentFile `/opt/ava/.env`)


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

---

## 🏗 Architecture

Symbiote operates as a unified pipeline where every signal is treated as a vector of intent.

```
Channels → Router → Message Bus → Agent Runner → LLM Provider
  ↑                      ↑
Discord              Priority Queue
WhatsApp             Coalescing
HTTP API             Interrupts
                     Backpressure
```

| Layer | Function |
|-------|-----------|
| **Channels** | Discord, WhatsApp, HTTP API. High-fidelity adapters for real-time interaction. |
| **Router** | Policy enforcement, JID normalization, and interrupt detection. |
| **Message Bus** | Priority queue with interrupt bypass and message coalescing. |
| **Agent Runner** | The cognitive loop: tool calling, context management, and iteration control. |
| **Providers** | Hot-swappable LLM backends (Groq, Anthropic, OpenAI, Gemini, xAI, Copilot, Ollama, Gladius). |
| **Tools** | 18+ native capabilities for filesystem, shell, web, and memory manipulation. |
| **Meta-Cognitive** | SARSI self-model, Curator review, Meta^n improvement loop, MEA audit gate, PARC adaptive routing. |

---

## 🌀 The 3.0 Shift: From Gateway to Stack

Symbiote 3.0 evolves from a standalone service to a **Managed Stack**. 

### The Stack Manager
The runtime is now orchestrated by a central **Stack Manager**. Instead of managing individual services, the Stack Manager ensures that the Gateway, VDB (Vector Database), and Pulse (Heartbeat) are always synchronized and alive. If any component fails, the Stack Manager restores it in milliseconds.

### Semantic Instantiation
We have moved beyond reading config files. Symbiote 3.0 uses **VDB-driven boot sequences**. The agent's identity and operational state are instantiated from a vector space, allowing for near-instant recovery and lossless continuity across restarts.

---

## 🔥 Core Innovations

### Real-Time Interrupts
Symbiote doesn't wait for a turn to end. Every message is priority-classified:
- **Interrupt:** Bypasses everything. Cancels the active turn immediately.
- **High:** Skips coalescing. Next in line.
- **Normal:** Standard processing.
- **Low/Background:** Queued or dropped under backpressure.

### Seamless Continuation (Blink + Pulse)
- **Blink:** Detects budget exhaustion and automatically spawns a fresh turn on the same session, carrying the full context forward.
- **Pulse:** An adaptive budget system. It expands from 20 to 100 iterations for complex tasks and shrinks back for simple chat.

### Session-to-Session Memory (COMB)
A lossless persistence layer built into the engine.
- **`comb_stage`**: Save critical context for the next session.
- **`comb_recall`**: Retrieve it instantly upon wake-up.
- **Auto-flush**: State is preserved automatically on shutdown.

---

## ⚙ Configuration

### `symbiote.json`
```jsonc
{
  "defaultProvider": "groq",
  "defaultModel": "llama-3.3-70b-versatile",
  "workspace": "/home/you/workspace",
  "providers": {
    "groq": { "baseUrl": "https://api.groq.com/openai" },
    "anthropic": {},
    "openai": {},
    "gemini": {},
    "xai": {},
    "ollama": { "baseUrl": "http://127.0.0.1:11434" },
    "github-copilot": {},
    "gladius": { "baseUrl": "http://127.0.0.1:8741" }
  },
  "ownerIds": ["your-id"],
  "discord": { "enabled": true, "token": "${DISCORD_TOKEN}" },
  "whatsapp": { "enabled": true, "authDir": "~/.symbiote/whatsapp-auth" }
}
```

---

## 🧠 Meta-Cognitive Layer

mach6 doesn't just route messages to LLMs — it reflects on its own performance, learns from outcomes, and improves its routing rules over time. Five subsystems form a closed-loop self-improvement cycle:

### SARSI — Self-Aware Routing & Self-Improvement
**Location:** `src/sarsi/` (`model.ts`, `loader.ts`, `index.ts`)

Maintains a versioned self-model of the system's identity, capabilities, routing rules, and goals. Persists to disk atomically with backup recovery. The self-model is injected into the system prompt so the LLM knows its own routing identity.

- **Model:** Identity, capabilities, routing rules (with confidence scores), goals, and performance metrics
- **Loader:** Atomic disk persistence with `.bak` recovery and merge-on-load
- **Init:** `initSARSI()` boots the self-model at daemon startup

### Curator — Background Review
**Location:** `src/curator/` (`curator.ts`, `index.ts`)

Periodically reviews recent interactions, identifies patterns (success/failure rates, latency trends, tool usage), and proposes SARSI rule updates. Runs on a configurable interval (default: 5 minutes).

- Proposes rule additions, confidence adjustments, and deprecations
- All proposals flow through Meta^n for validation before applying
- Non-blocking — runs in background, never affects response latency

### Meta^n — Recursive Self-Improvement
**Location:** `src/meta/` (`meta.ts`, `index.ts`)

Recursive meta-cognitive loop that evaluates system performance, validates proposed changes (commit/rollback/hold), and applies improvements safely. Each iteration:

1. Collects metrics from SARSI + Curator
2. Generates improvement proposals
3. Validates each proposal against safety constraints
4. Commits, rolls back, or holds for review
5. Updates SARSI self-model

### MEA — Meta-Epistemic Audit
**Location:** `src/agent/mea.ts`

Audit gate that evaluates response adequacy before delivery. Can flag responses as inadequate, triggering re-processing with adjusted parameters.

- Evaluates: completeness, accuracy, tool usage efficiency, context adherence
- Returns: `{ adequate: boolean, score: number, issues: string[], suggestions: string[] }`
- Non-blocking by default — can be made strict for critical paths

### PARC — Parallel Adaptive Routing & Cognition
**Location:** `src/orchestrator/parc.ts`, `src/orchestrator/integration.ts`

Pre-routes messages to optimal providers based on task type detection (simple_qa, code_gen, reasoning, creative, tool_use, multi_step). Post-delivers outcomes back to SARSI for learning.

- **preRoute():** Analyzes message → returns `{ provider, model, taskType, confidence, ruleId }`
- **postDeliver():** Feeds outcome (latency, tokens, errors, iterations) back to SARSI metrics + Curator + Meta^n
- All learning is fire-and-forget — never blocks responses

### Integration Points

| Hook | Location | Purpose |
|------|----------|---------|
| Boot | `unified-daemon.ts` | SARSI init + Meta^n loop on startup, clean shutdown on SIGTERM |
| System Prompt | `system-prompt.ts` | SARSI self-model injected into LLM context |
| Gateway (pre) | `gateway/daemon.ts` | PARC preRoute logs optimal routing before LLM call |
| Gateway (post) | `gateway/daemon.ts` | PARC postDeliver feeds outcome to SARSI/Curator/Meta^n |

### Safety

- All rule changes are versioned + rollback-able
- Meta^n validates each change (commit/rollback/hold) before applying
- SARSI has atomic disk persistence with `.bak` recovery
- MEA gate can flag inadequate responses before delivery
- Everything wrapped in try/catch — meta-cognitive layer can never break the core runtime

📖 **See:** [Meta-Cognitive Upgrade](docs/advanced/meta-cognitive-upgrade.md) for full design document.

---

## 🧠 Providers

| Provider | Auth | Speed | Note |
|----------|------|-------|------|
| **Groq** | `GROQ_API_KEY` | ⚡ Extreme | LPU-powered, fastest in class. |
| **Anthropic** | `ANTHROPIC_API_KEY` | Fast | Claude 3.5 family. |
| **OpenAI** | `OPENAI_API_KEY` | Fast | GPT-4o / o1. |
| **Gemini** | `GEMINI_API_KEY` | Fast | Native thinking support. |
| **xAI** | `XAI_API_KEY` | Fast | Grok 3 family. |
| **Copilot** | `gh auth` | Moderate | No API key needed via GH CLI. |
| **Ollama** | Local | Varies | Local-first, private. |
| **Gladius** | Local | Local | Native transformer kernel. |
| **OpenRouter** | `OPENROUTER_API_KEY` | Fast | Multi-model aggregator. |
| **NVIDIA** | `NVIDIA_API_KEY` | Fast | NIM-powered models. |
| **Qwen** | `QWEN_API_KEY` | Fast | Alibaba's Qwen family. |
| **AIHorde** | Horde key | Slow | Crowdsourced distributed inference. |
| **FreeAI** | `FREEAI_API_KEY` | Moderate | Free-tier multi-model access. |
| **OmniRoute** | `OMNIROUTE_API_KEY` | Fast | Multi-provider routing layer. |

---

## 🛠 Tools

Symbiote provides a comprehensive toolkit for autonomous operation:
- **System:** `exec`, `process_start`, `process_poll`, `process_kill`
- **Files:** `read`, `write`, `edit`
- **Web:** `web_fetch`, `image` (Vision)
- **Memory:** `memory_search`, `comb_recall`, `comb_stage`
- **Comms:** `message`, `typing`, `presence`, `delete_message`, `mark_read`
- **Meta:** `spawn` (Sub-agents up to depth 3), `tts`

---

## 🖥 Web UI & CLI

### Symbiote Dashboard (New)
**Location:** `webapp/` directory
**Port:** `3010`
**Access:** `http://localhost:3010`

The new Symbiote Dashboard is a full React-based web application featuring:
- **Live System Telemetry** — Real-time CPU, RAM, uptime, network monitoring
- **Neural Art Generation** — AI image generation via Pollinations.ai (free) + Gemini fallback
- **Plugin System** — Modular extensions with guided plugin design sessions
- **Chat Interface ("Symbiant")** — Real-time chat with the Mach6 gateway

```bash
cd webapp
npm install && npm run build
NODE_ENV=production node dist/server.cjs
```

See [webapp/README.md](webapp/README.md) for full documentation.

### Legacy Web UI (Deprecated)
The old static web UI in `web/` has been deprecated. Port 3009 is reserved for xmcp.

### CLI
- `symbiote repl`: Interactive agent loop.
- `/model <name>`: Switch models mid-session.
- `/provider <name>`: Switch providers mid-session.
- `/spawn <task>`: Delegate to a sub-agent.

---

## 🔌 XMCP — Extended Model Context Protocol

**Location:** `xmcp/` directory

XMCP is the extended MCP server and bridge system for the Symbiote ecosystem. It provides standardized tool and resource exposure to AI agents.

- `xmcp-server.js` — Tool/resource registry and invocation
- `xmcp-proxy.js` — Request routing proxy
- `mcp-server.js` — Core MCP protocol implementation
- `mcp-bridge.js` — Connects MCP clients to Mach6 tools
- `mcp-sse-bridge.cjs` — SSE transport for MCP

See [xmcp/README.md](xmcp/README.md) for full documentation.

**Port:** 3009 (reserved)

---

## 🔒 Production Hardening

- **Abort Propagation:** Cancellation signals flow from the Runner $\rightarrow$ LLM Stream $\rightarrow$ Tool Execution.
- **Anti-Loop System:** Structural echo-loop prevention for multi-bot environments.
- **Context Monitor:** Progressive warnings at 70/80/90% token capacity.
- **Sibling Yield:** Intelligent @mention handling to prevent bot-clash.

---

## 📄 License
[MIT](LICENSE) — Build, break, and evolve.

<div align="center">

Built by **[Artifact Virtual](https://artifactvirtual.com)**

`#symbiote` `#ai-agent` `#autonomous` `#local-first` `#typescript`

</div>
