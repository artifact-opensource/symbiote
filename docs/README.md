# Symbiote

**AI agent framework. Single process. Any machine.**

Symbiote is a persistent daemon that connects messaging platforms, LLM providers, and tool execution into a single agentic loop — with real-time interrupts, message coalescing, and sub-agent orchestration.

No Docker. No Redis. No cloud dependencies. **Your machine, your data, your keys.**

## Key Features

- **7 LLM providers** — Groq (default, free tier), Anthropic, OpenAI, xAI (Grok), GitHub Copilot, Ollama (local), Gladius. Hot-swappable mid-session.
- **Real-time interrupts** — say "stop" and the agent stops. Immediately.
- **Message coalescing** — three rapid messages become one coherent request
- **Blink** — seamless iteration budget continuation. The wall doesn't exist.
- **Pulse** — adaptive iteration budget. Starts small, grows when needed.
- **COMB** — lossless session-to-session memory. Zero external dependencies.
- **Agent creation wizard** — interactive setup with identity scaffolding
- **Discord + WhatsApp + HTTP API + Web UI + CLI**
- **18+ built-in tools** — file I/O, shell, browser, TTS, memory, messaging
- **Sub-agent spawning** — up to depth 3
- **Activity-aware heartbeat** — adapts to user presence
- **Cross-platform** — Windows, Linux, macOS. CPU-only, no GPU required.

## Quick Links

- [Installation →](getting-started/installation.md)
- [Quick Start →](getting-started/quick-start.md)
- [Setup Wizard →](getting-started/wizard.md)
- [Architecture →](core/architecture.md)
- [Providers →](providers/overview.md)
- [GitHub](https://github.com/Artifact-Virtual/symbiote)
- [npm](https://www.npmjs.com/package/symbiote-core)

## What You Can Build

| Use Case | How |
|----------|-----|
| Personal AI assistant | Discord bot + WhatsApp, always-on daemon |
| Development copilot | CLI REPL with file/exec tools, persistent sessions |
| Multi-agent system | Sub-agent spawning with depth control |
| Enterprise chatbot | HTTP API + tool policy engine + session management |
| Multi-platform bridge | Same agent identity across Discord, WhatsApp, and HTTP |
| Local-first agent | Ollama + local tools, zero cloud dependency |

---

Built by [Artifact Virtual](https://artifactvirtual.com). v1.5.0. MIT License.
