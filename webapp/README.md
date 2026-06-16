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

[Quick Start](#-quick-start) · [Architecture](#-architecture) · [The 3.0 Shift](#-the-30-shift) · [Config](#-configuration) · [Providers](#-providers) · [Tools](#-tools)

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

**Web UI:** Accessible at `http://localhost:3006`. Features real-time tool visualization, session management, and live config tuning.

**CLI:** 
- `symbiote repl`: Interactive agent loop.
- `/model <name>`: Switch models mid-session.
- `/provider <name>`: Switch providers mid-session.
- `/spawn <task>`: Delegate to a sub-agent.

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
