# Changelog

## v1.7.0 — Embedded VDB, Voice Pipeline, Webchat, Context Monitor (2026-03-11)

### Features
- **VDB — Embedded persistent memory** — zero-dependency embedded database with BM25 + TF-IDF hybrid search. JSONL append-only storage, lazy loading, idle eviction, crash-safe. Real-time 5-second pulse indexes new messages incrementally. Session archive auto-ingestion. Three new tools: `memory_recall`, `memory_ingest`, `memory_stats`.
- **Voice pipeline** — transparent voice support. Inbound voice notes auto-transcribed via faster-whisper STT. Outbound voice replies generated via Edge TTS (6 voices). Agent sees plain text — voice handling is fully transparent.
- **Web UI overhaul** — dark glass aesthetic, session sidebar, streaming responses with tool call visualization, latency badges, live config panel, sub-agent monitoring. Separate `webPort` configuration (default: 3009). Mobile responsive.
- **Context monitor** — real-time token tracking with progressive thresholds (70% warn, 80% auto-compact, 90% emergency flush). COMB integration for pre-compaction staging. Transcript save on emergency.
- **DM support** — direct message handling across all channels.
- **IPC Identity** — HMAC-SHA256 signed inter-process communication for verified agent identity in multi-agent deployments.

### Improvements
- **Tool count:** 18 → 24 (added `memory_recall`, `memory_ingest`, `memory_stats`, `tts`, `subagent_status`, `mark_read`)
- **Provider count:** 8 (Groq, Anthropic, OpenAI, Gemini, xAI, GitHub Copilot, Ollama, Gladius)
- **Web UI port separation** — `webPort` config key separates webchat from the HTTP API port
- **BOOTSTRAP.md prompt file** — context monitor now loads operational protocol from `BOOTSTRAP.md` if present in workspace

### Stats
- ~17,000 lines of TypeScript
- 76 source files
- 24 built-in tools
- 8 LLM providers
- 2 channel adapters + HTTP API + Web UI
- 37+ documentation files

---

## v1.6.0 — Native Gemini, 8 Providers, Multi-User Deployment (2026-03-07)

### Features
- **Native Gemini provider** — `@google/genai` SDK integration with streaming, function calling, thinking support, and automatic `thoughtSignature` preservation across tool call roundtrips.
- **8 LLM providers** — added Gemini alongside Groq, Anthropic, OpenAI, xAI, GitHub Copilot, Ollama, Gladius.
- **Agent creation wizard (6-step)** — identity, provider, channels, access, workspace, review. Generates `SOUL.md`, `IDENTITY.md`, `USER.md`, `AGENTS.md`, `HEARTBEAT.md`.
- **Multi-user deployment** — one Symbiote install serves multiple user profiles with isolated workspaces and configs.
- **Sandbox wildcard ownerIds** — `"*"` allows open access for testing/demo deployments.
- **De-branded web UI** — agent name and emoji pulled from config, not hardcoded.
- **Self-contained QR HTML** — WhatsApp QR pairing page works without CDN dependencies.
- **Landing page** — `symbiote.artifactvirtual.com` with CNAME support.

### Fixes
- **dotenv auto-import** — `.env` files are now loaded automatically at startup (previously ignored silently).
- **xAI provider registration** — `xai` was defined but not registered in the provider map. Fixed.
- **Default provider** — changed from `github-copilot` (requires `gh` CLI auth) to `groq` (free API key, fastest).
- **Discord chatType detection** — correctly identifies channel vs thread messages.
- **Gemini schema adaptation** — automatically strips `additionalProperties` from tool schemas (Gemini rejects them).

### Stats
- 8 LLM providers
- 18+ built-in tools
- 2 channel adapters + HTTP API
- 38 documentation files

---

## v1.5.0 — Blink, Pulse, COMB, 7 Providers, Agent Wizard (2026-03-06)

### Features
- **Blink** — seamless session continuation. Agent hits iteration budget → daemon spawns fresh turn on same session. User sees nothing. Up to 5 consecutive blinks with periodic checkpoints for crash recovery.
- **Pulse** — adaptive iteration budget. Starts at 20 iterations. Expands to 100 when the agent needs it. Reverts when demand passes. Persists across restarts.
- **Native COMB** — lossless session-to-session memory, pure Node.js, zero external dependencies. Automatic fallback if Python COMB exists. `comb_recall` and `comb_stage` built-in tools. Session auto-flush on shutdown.
- **Groq provider** — free tier, 280-1000 tok/sec on LPU hardware. Auto-retry on rate limits with server-specified delays. **New default provider.**
- **xAI (Grok) provider** — Grok 3, Grok 3 Fast, Grok 3 Mini, Grok 3 Mini Fast. OpenAI-compatible with rate limit handling.
- **Ollama** — fully local, fully offline. No API key needed. Local fallback.
- **Agent creation wizard** — 6-step interactive setup generates `mach6.json`, `.env`, and identity files (SOUL.md, IDENTITY.md, USER.md, AGENTS.md, HEARTBEAT.md). Clean-room templates with zero bleed.
- **Agent scaffold** — `scaffoldAgent()` function generates personalized identity files for new agents.
- **dotenv auto-loading** — `.env` file automatically loaded at startup. No manual setup required.
- **Cron budget manager** — jobs declare resource usage, scheduler enforces daily limits. Warns at 80%, blocks at 100%.
- **Context monitor** — tracks token usage in real-time with progressive thresholds (70% warn, 80% compact, 90% emergency). Auto-compacts context before overflow. Emergency transcript flush to disk.
- **Memory integrity** — validates HEKTOR index files at startup (size checks, test queries). Auto-rebuilds corrupt indices. Atomic file writes prevent corruption from interrupted writes.

### Improvements
- **Heartbeat scheduler** — activity-aware: scales frequency based on user activity (30min active, 2h idle, 6h sleeping). Quiet hours suppression.
- **Boot sequence** — structured 5-step boot with per-step timeouts and degraded mode. Non-critical failures don't crash the daemon.
- **Provider count:** 4 → 7 (added Groq, xAI, Ollama)
- **Default provider:** `github-copilot` → `groq` (free, fastest, no CLI auth needed)
- **Full documentation overhaul** — 37 docs across 8 sections, GitBook-compatible

### Stats
- 7 LLM providers (Groq, Anthropic, OpenAI, xAI, GitHub Copilot, Ollama, Gladius)
- 18+ built-in tools (including `comb_recall`, `comb_stage`)
- 2 channel adapters + HTTP API
- 37 documentation files

---

## v1.4.0 — MCP Server, Anti-Loop & Degradation Protection (2026-03-05)

### Features
- **MCP server mode** — expose Symbiote tools as an MCP server for external agents and editors
- **Anti-loop system** — structural prevention of bot echo loops in multi-bot Discord environments. Detects coordination phrases, suppresses recursive mentions, maintains normal flow when safe
- **Systemd service integration** — production-grade process management with auto-restart, resource limits, and journal logging

### Improvements
- **Provider retry hardening** — increased retry delays (2s/5s/10s), fresh abort signals on retry to prevent stale timeout propagation
- **GitHub Copilot timeout** — extended token exchange timeout from 15s to 30s for slower networks
- **Source sanitization** — all hardcoded paths replaced with portable `process.cwd()` resolution
- **Full documentation suite** — 28 docs across 7 sections, GitBook-compatible structure

### Stats
- 66 source files, ~13,800 lines of TypeScript
- 14+ built-in tools + MCP bridge + MCP server
- 4 LLM providers (GitHub Copilot, Anthropic, OpenAI, Gladius)
- 2 channel adapters + HTTP API
- 28 documentation files

---

## v1.3.0 — Multi-Bot Coordination & ATM (2026-03-03)

### Features
- **Adaptive Temperature Modulation (ATM)** — dynamic per-task temperature control with four profiles: precise, balanced, creative, exploratory
- **Multi-bot coordination** — sibling bot detection, mention-based yield, cooldown-based echo loop prevention
- **Sister message injection** — context-aware message framing for bot-to-bot communication

### Improvements
- Professional GitBook documentation
- Gitee mirror synchronization

---

## v1.2.0 — Multi-Bot Coordination (2026-02-28)

### Features
- Sibling bot ID configuration for multi-bot environments
- Channel-level cooldown for sister bot messages
- Mention-based routing — @mention one bot, only that one responds

---

## v1.1.0 — Brand Kit & First npm Publish (2026-02-28)

### Features
- Interactive CLI setup wizard (`symbiote init`)
- Branded terminal output with gradient headers
- Published to npm as `symbiote-core`

### Fixes
- CVE fix: override `undici >=6.23.0` (GHSA-g9mf-h72j-4rw9)
- README overhaul with Mermaid architecture diagram

---

## v1.0.0 — First Stable Release (2026-02-28)

### Features
- Full cross-platform support (Windows, Linux, macOS)
- Discord adapter (discord.js v14)
- WhatsApp adapter (Baileys v7)
- HTTP API with SSE streaming
- Web UI — single HTML file, no build step
- 18 built-in tools
- 4 LLM providers (GitHub Copilot, Anthropic, OpenAI, Gladius)
- MCP bridge for external tool servers
- Priority message bus with interrupts and coalescing
- Session management with TTL and persistence
- Sub-agent spawning (max depth 3)
- Tool policy engine with resource budgets
- Boot sequence validation
- Graceful shutdown with session persistence
- Hot-reload via SIGUSR1

### Stats
- ~8,400 lines of TypeScript
- 18 built-in tools
- 4 LLM providers
- 2 channel adapters + HTTP API
- Cold boot to connected: ~2.3s

---

Built by [Artifact Virtual](https://artifactvirtual.com). MIT License.
