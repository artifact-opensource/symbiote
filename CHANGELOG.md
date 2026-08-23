# Changelog

## v3.0.0 (2026-08-23) — Apex

### Production Hardening
- Enforced HTTP API authentication across web and API chat paths
- Added loopback-safe API host defaults and stricter CORS validation
- Prevented unverified HTTP owner impersonation
- Validated config before startup and hot reload
- Reduced sensitive request/message logging in production paths

### Installer & Setup
- Replaced the legacy wizard with a shared guided setup flow
- Added a desktop installer UI served by `symbiote init --ui`
- Added double-click launchers: `install.command` and `install.cmd`
- Rebuilt `symbiote install` to install, build, configure, and launch in one flow
- Preserved existing `.env` secrets during reconfiguration

### Runtime Reliability
- Fixed sub-agent depth accounting
- Implemented real sub-agent kill and steer behavior via abort + resume
- Removed accidental admin-tier treatment for sub-agents
- Fixed packaged browser sidecar path discovery
- Unified runtime version reporting through package metadata

---

## v2.1.0 (2026-03-12)

### Circuit Breaker Failover
- Providers that fail 3x consecutively are automatically disabled for 60s cooldown
- Latency-aware routing: tracks moving average latency per provider, prefers faster ones when all healthy
- Auto-recovery: half-open probes after cooldown, full recovery after 2 consecutive successes
- Health states: healthy -> degraded -> unhealthy -> circuit-open (automatic transitions)
- Circuit-open providers skipped during fallback chain (no wasted retries)
- See: [Circuit Breaker](docs/core/circuit-breaker.md)

### Session Hot Resume
- Session state persisted to disk every 60s
- On process termination: all active sessions marked and flushed to disk before exit
- Startup restoration: previous session state reloaded on boot with 24h age validation
- Gateway restarts no longer lose conversation context registration
- See: [Sessions](docs/core/sessions.md)

### Metrics Collector
- Provider metrics: call count, error count, token usage (in/out), latency histograms (p50/p90/p99)
- Tool metrics: per-tool call frequency, latency, error rates
- Session metrics: turn count, active session tracking
- Ring buffer design: bounded memory, automatic eviction of old samples
- Auto-flush to JSON every 5 minutes; zero dependencies (pure Node.js stdlib)
- See: [Metrics](docs/core/metrics.md)

### Configurable Idle Emoji
- Idle status indicator emoji now configurable via `idleEmoji` field in `mach6.json`
- Also configurable via `IDLE_EMOJI` environment variable
- Defaults to existing behavior when absent

### Enhanced Health Endpoint
- `GET /api/v1/health` now returns comprehensive gateway status
- Fields: version, uptime (human-readable), PID, provider health states (per-provider circuit breaker status), metrics snapshot (tokens/latency/errors), memory usage (RSS + heap in MB), active turns, session count, tool count, connected channels

### Other
- Dependabot security patches (file-type)
- Documentation and landing page updates for Symbiote rebrand

---

## v2.0.0 (2026-03-12)

### Provider Health Monitor — Circuit Breaker + Intelligent Failover
- **Circuit breaker pattern:** Providers that fail 3× consecutively are automatically disabled for 60s cooldown
- **Latency-aware routing:** Tracks moving average latency per provider, prefers faster ones when all healthy
- **Auto-recovery:** Half-open probes after cooldown, full recovery after 2 consecutive successes
- **Health states:** healthy → degraded → unhealthy → circuit-open (with automatic state transitions)
- **Fallback chain integration:** Circuit-open providers are skipped during failover — no wasted retries
- File: `src/providers/health.ts` (202 lines)

### 🔥 Session Hot Resume — Survive Restarts
- **Session state persistence:** Active session metadata saved to disk every 60s
- **Graceful shutdown capture:** On SIGTERM/SIGINT, all active sessions marked and saved
- **Startup restoration:** Previous session state restored on boot with age validation (24h expiry)
- **Zero-loss restarts:** Gateway restarts no longer lose conversation context registration
- File: `src/sessions/hot-resume.ts` (193 lines)

### Metrics Collector — Runtime Observability
- **Provider metrics:** Call count, error count, token usage (in/out), latency histograms (p50/p90/p99)
- **Tool metrics:** Per-tool call frequency, latency, error rates
- **Session metrics:** Turn count, active sessions tracking
- **Ring buffer design:** Bounded memory, automatic eviction of old samples
- **Persistent:** Auto-flush to JSON every 5 minutes + shutdown flush
- **Zero dependencies:** Pure Node.js stdlib, non-blocking fire-and-forget recording
- File: `src/metrics/collector.ts` (466 lines)

### 🏥 Enhanced Health Endpoint
- `GET /api/v1/health` now returns comprehensive gateway status:
  - Version, uptime (human-readable), PID
  - Provider health states (circuit breaker status per provider)
  - Metrics snapshot (tokens, latency, errors)
  - Memory usage (RSS + heap in MB)
  - Active turns, session count, tool count, connected channels

### Infrastructure
- Symbiote rebrand (v1.7 → v2.0 naming)
- IPC Identity (HMAC-SHA256 inter-agent authentication)
- Web Automation Suite (14 browser tools via Playwright sidecar)
- VDB embedded vector database with 5s real-time indexing pulse
- Voice middleware (Whisper transcription + MeloTTS generation)
- Webchat dark glass UI overhaul
- One-command installer (bash + PowerShell)
- UTF-8 BOM stripping for Windows config compatibility

### By the Numbers
- **Total source:** ~19,000 lines TypeScript
- **Built-in tools:** 31
- **Providers:** 8 (Anthropic, OpenAI, GitHub Copilot, Gemini, Groq, Ollama, xAI, GLADIUS)
- **New v2.0 code:** 861 lines across 3 new modules

---

## v1.7.0 (2026-03-10)

### Features
- VDB persistent memory engine
- 10-second real-time indexing pulse
- COMB → HEKTOR vectorization sidecar
- Context Monitor (proactive context management)

---

## v1.6.0 (2026-03-08)

### Features
- Provider fallback chain
- Session archival and context windowing
- WhatsApp Web integration
- Webchat visual overhaul

---

## v1.5.0 and earlier

See git history.
