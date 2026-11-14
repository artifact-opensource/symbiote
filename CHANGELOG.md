# Changelog

## Unreleased

## v6.0.0 (2026-11-15) — Legacy Gateway

Full release notes: [RELEASE_NOTES_v6.0.0.md](docs/releases/RELEASE_NOTES_v6.0.0.md)

### Breaking
- Removed the Electron desktop shell and its launcher, tray, updater, and mini-chat features. The browser-based Control Room remains available through the Gateway.
- `npm start` now starts the Gateway directly. On Windows, the MSI installs the Gateway as an automatically-starting Windows service.

### Added
- Native Git operations and hosting connectors.
- A bundled Node.js runtime and service wrapper in the Windows MSI, with a browser-based setup flow.

### Changed
- Session storage is centralized in the configured workspace session directory.
- Source installers and release packaging no longer install or build Electron.

### Fixed
- Cloudflare model selection and Discord provider/model fidelity.
- MetaTrader initialization when no terminal path is configured.
- Windows MSI setup, persistent data handling, and service install/uninstall coverage.

## v5.7.1 (2026-11-07) — Stability and Gateway Reliability

Full release notes: [RELEASE_NOTES_v5.7.1.md](docs/releases/RELEASE_NOTES_v5.7.1.md)

### Added
- Cloudflare Workers AI provider support, account-scoped model discovery, and documented SARSI model assignments.
- Artifact Engine as a local OpenAI-compatible provider, including model discovery and neural-memory embedding support.
- Discord provider/model selection and discovery for live provider hot-swapping.

### Changed
- Electron now starts and supervises the Gateway, detects stale build output, and coordinates clean restarts without launching competing Gateway processes.
- Session summary caching and coalesced neural-memory backfills reduce repeated work during startup and session listing.
- Provider-specific `contextWindow` and `maxTokens` settings now budget conversation history and tool schemas, reserving room for generated output and safety overhead.

### Fixed
- Cloudflare context overflow is prevented by selecting relevant tool schemas and trimming conversation history to fit the model's configured context window.
- WebSocket handshake timeout handling and Discord interaction acknowledgement/reconnect paths are more resilient.
- Gateway startup and restart handling avoid stale child processes and repeated initialization work.

## v5.7.0 (2026-11-02) — Apex

Full release notes: [RELEASE_NOTES_v5.7.0.md](docs/releases/RELEASE_NOTES_v5.7.0.md)

### Added
- A faster, staged startup: the Gateway signals core readiness before Gamma starts integrations, channels, memory, market-data, and self-improvement initialization concurrently; Electron shows an animated startup and recovery screen, and heavy webapp views load on demand.
- A deterministic, 1,000-particle hero orb with transitions across idle, thinking, executing, and responding states, plus a responsive 3D Memory graph with clustered nodes.
- A first-class connector engine with REST and MCP adapters, an initial catalog for GitHub, Notion, Slack, Figma, and Canva, encrypted credential storage, per-agent capability grants, health checks, and execution history.
- An agent-enabled Markets workspace with public price/history feeds, persistent chart drawings and indicators, dedicated chat and voice input, plus an optional MetaTrader 5 bridge.
- OpenSky aircraft data and additional public intelligence and market sources through the resource aggregator.
- Optional local neural memory using Ollama embeddings and a persistent HNSW index alongside lexical VDB retrieval.
- Profile-driven hands-free voice activation, draft dictation with a trailing “send” command, and optional offline Vosk speech recognition.
- FreeAI provider registration and provider/model discovery for interactive provider switching.
- A gateway-supervised native recovery UI, production CI/release workflows, repository label automation, and desktop/mobile screenshots.
- Admin-only n8n workflow operations and safer local-first n8n integration controls.

### Changed
- Refined the webapp, API registry, integrations, browser, IDE, maps, health, and Markets surfaces for more consistent layout and theming.
- Improved short-recording speech recognition, profile-based wake-word matching, Windows project-terminal lifecycle handling, session continuity, and release packaging.

### Fixed
- Background initialization failures are reported without holding up core Gateway readiness; startup and recovery states are surfaced in the Electron UI.
- Improved chart-state persistence and public data-source status handling.
- Corrected the hero orb display size and removed its brightness control without changing global appearance settings.

### Upgrade notes
- No existing configuration migration is required. Connectors and neural memory are optional; connected services need their own credentials, and neural memory requires a locally installed Ollama embedding model.
- Source checkouts should use `npm ci`, `npm --prefix webapp ci`, then `npm run build`.

## v5.6.2 (2026-10-29) — Apex

Full release notes: [RELEASE_NOTES_v5.6.2.md](docs/releases/RELEASE_NOTES_v5.6.2.md)

### Added
- A manual update check in the Control Room with visible MSI download progress.
- Safe, same-origin installer defaults and setup submissions with bounded request bodies and clear recovery states.

### Changed
- Source installers use lockfile-based dependency installs, provision the Electron and web build runtimes, and build the Windows shortcut launcher.
- Release publishing selects notes from the tagged version and generates version-matched Windows MSI and checksum assets.
- Runtime, session, heartbeat, integration, and workspace UI reliability updates.

### Fixed
- Rebuilt the Windows shortcut launcher without an unconditional administrator relaunch.
- Installer defaults no longer return existing provider or Discord secrets to the browser.
- Installer startup recovers from an occupied preferred port; setup errors distinguish invalid requests from server failures.

### Upgrade notes
- No configuration migration is required.
- Source checkouts should use `npm ci`, `npm --prefix webapp ci`, then `npm run build`.

## v5.6.1 (2026-10-25) — Apex

Full release notes: [RELEASE_NOTES_v5.6.1.md](docs/releases/RELEASE_NOTES_v5.6.1.md)

### Fixed
- **Repeated assistant responses:** completion review no longer runs after read-only tool calls, and internal review prompts and draft responses are excluded from persisted session history and checkpoints.
- **Session-save races:** concurrent session writes now use unique temporary files, and persistence failures are reported with session context without exposing raw filesystem errors to Discord.
- **Process output and startup failures:** expected broken stdout/stderr pipes no longer flood operational health reporting; shell tools validate working directories and executables before launch and return clear startup errors.
- **OpenRouter stream completion:** repeated completion chunks no longer emit duplicate end-of-turn events. Streamed 202 responses are accepted, while asynchronous acknowledgements without a completion stream fail clearly instead of being mistaken for completed turns.

### Changed
- SARSI routing is constrained to the configured provider/model and explicitly configured fallbacks; fresh routing defaults use `openrouter/free`.
- Provider retry behavior was hardened.
- Added regression coverage for review-history filtering, persistence races, stream completion, provider routing, and process failures.

### Upgrade notes
- No configuration migration is required.
- Run `npm ci` followed by `npm run build` when upgrading from a source checkout.

## v5.6.0 (2026-10-23) — Apex

### Added
- **HttpMcpBridge integration:** added support for remote n8n connections through the HttpMcpBridge, enhancing MCP server handling for external workflow orchestration.
- **WhatsApp QR support:** added WhatsApp QR code display to the GatewayStatus channel tiles for streamlined WhatsApp channel setup.
- **Enhanced health telemetry:** improved gateway issue tracking and added provider call tracking with gateway lifecycle events for better observability.
- **Activity states:** updated activity states and enhanced UI components for improved runtime visibility.
- **Idempotency metadata:** added idempotency metadata to all 62 tool definitions across 51 tool files, improving tool execution reliability and preventing duplicate operations.

### Changed
- **HeroAgentOrb:** enhanced responsiveness and fixed dimension/style consistency issues.
- **Workspace hero graph:** fixed overflow issues and improved graph interaction styling.
- **Uptime stopwatch and channel tiles:** updated styles for improved visual consistency.
- **General UI components:** updated styles and components across the application for improved UX.
- **Electron gateway lifecycle:** stabilized the desktop-to-Gateway lifecycle handling for more reliable communication.

### Fixed
- **OpenRouter key propagation:** fixed stale OpenRouter key propagation to ensure credentials are correctly refreshed.
- **Workspace hero graph overflow:** fixed overflow issues in the workspace hero graph visualization.
- **Surfacaced errors:** fixed surfaced errors and added Windows app icon.
- **HeroAgentOrb dimensions:** fixed HeroAgentOrb dimensions and styles for consistency.

### Upgrade notes
- No configuration migration is required.
- Run `npm ci` followed by `npm run build` when upgrading from a source checkout.

## v5.5.0 (2026-10-17) — Apex

### Added
- **Control Room and desktop:** rebuilt the live web dashboard and Electron shell, with runtime health/setup, live uptime, and dedicated project, IDE, integrations, cron, threads, games, and memory views.
- **Project operations:** project-scoped task tracking, assignment and progress visibility, project editing and archiving, and project selection directly in the agent IDE.
- **Agent capabilities:** scheduled work, persistent threads, workspace tasks, speech-to-text, image generation, Google Workspace, and cloud integrations.
- **Windows deployment:** x64 MSI installer and service/firewall install and uninstall workflows.
- **System resource telemetry:** a GPU dashboard card with adapter load and memory when available, plus per-logical-core CPU history.
- **Project memory:** project files are indexed alongside knowledge and sessions and are represented as a distinct, linked node family in the memory map.
- **Shared appearance controls:** brightness and primary/accent hue settings apply consistently across dashboard pages and desktop/web surfaces.

### Changed
- Memory similarity ranking now uses inverse-document-frequency-weighted sparse cosine similarity, with bounded, symmetric graph links and clearer source-specific coloring.
- The workspace hero graph now lays out conversations, projects, agents, and subagents as connected outward branches from the main agent.
- Windows GPU and host-counter collection now uses bounded queries, avoids overlapping GPU refreshes, and retries transient counter failures at the normal sampling cadence.
- Discord streaming updates are serialized to prevent duplicate or out-of-order progress messages.
- Added release build/test automation and Windows MSI release packaging.

### Fixed
- Restored visible primary-hue accents in the hero and page headers at both dark and light brightness settings.
- Prevented projects from appearing detached from the main agent in the workspace graph.
- Windows resource telemetry no longer treats a slow first sample as a persistent failure.
- Suppressed expected Windows missing-registry lookup noise during Node executable resolution.

### Upgrade notes
- No configuration migration is required.
- GPU metrics report unavailable when the operating system does not expose a supported adapter or counters.
- Rebuild source installations with `npm ci` followed by `npm run build`.

## v5.3.0 (2026-10-12) — Apex

### Added
- **Ops Memory:** a separate bounded operational-history store records coarse metadata from completed tool executions after delivery. It stores no command text, arguments, output bodies, or user messages; observations are workspace-scoped, deduplicated, capped, and expire by category.
- **Historical operational retrieval:** relevant past execution metadata can be surfaced for an operational user query with explicit expiry and a warning to verify volatile state before relying on it. No background model call or tool-loop decision was added.
- Tests for Ops Memory persistence, data minimization, deduplication, workspace scoping, expiry, corrupt-state reporting, opt-out, and context retrieval.
- Tests and diagnostics for Windows/Git Bash path mistakes, successful commands with intentionally empty output, Discord progress message sizing, and sensitive argument redaction.

### Changed
- The package metadata now targets `@symbiote-agi/symbiote` for public npm publishing; the installed CLI command remains `symbiote`.
- `exec` now distinguishes a successful silent command from absent results and provides actionable guidance for path and shell mismatches on Windows.
- Discord tool-progress previews are capped below Discord's 2,000-character message limit and redact common credential/header formats before display.
- README and release documentation now describe the current runtime, memory boundaries, tool execution, adaptive subsystems, channels, and security considerations.
- Version reporting remains package-metadata driven: the package, gateway banner, daemon, web status, and MCP server all resolve the same application version.

### Fixed
- Prevented Discord progress edits from exceeding the platform message-content limit.
- Clarified that Windows Git Bash is not a Linux filesystem: Windows drive paths and guessed `/workspace` or `/tmp` paths are not valid unless they exist in that shell.
- Successful `exec` calls with no stdout/stderr now return an explicit exit-code-0 result rather than an empty string.
- Restored and retained the committed Discord.js 14.25.1 dependency and lockfile after an unintended local downgrade.

### Included since v5.2.0
- More reliable tool-call pairing and session-message sanitization.
- Hardened session persistence, self-improvement evaluation, and long-running agent behavior.
- Corrected historical COMB wording and removed hard-coded OpenRouter quota/reset assumptions; retries now follow provider response metadata.

### Upgrade notes
- No configuration migration is required for this release.
- Ops Memory is enabled by default and can be disabled with `SYMBIOTE_OPS_MEMORY=0`.
- Run `npm ci` followed by `npm run build` when upgrading from a source checkout.
- On Windows, provide `workdir` instead of issuing `cd` with guessed paths; use `/c/...` for explicit Git Bash paths.

---

## v5.2.0 (2026-10-10) — Apex

Full notes are superseded by the v5.3.0 summary above; this section preserves the v5.2.0 release summary.

### Added
- Curator tool-bug detection (v5.1): per-tool failure windows, minor/major classification, retry/timeout/fallback proposals
- Memograph integration with shard-hash verification; `reseal` repair tool
- `fs` and `hardware` admin tools; `read` handles directories, binary and very large files; `write` supports append and base64
- Native browser CUA driver, channel-specific formatting, live CLI interrupts
- Skill ingestion and `persona_digest`

### Changed
- Tool sandbox off by default (`SYMBIOTE_SANDBOX=1` re-enables it); `exec` default timeout 600 s
- Prompt-injection guard rebuilt with trust levels, weighted patterns and obfuscation-aware normalisation (`SYMBIOTE_INJECTION_GUARD`)
- Naming unified on `symbiote`; environment variables are `SYMBIOTE_*`

### Fixed
- Shell execution on Windows (PowerShell-first), tree-kill for timeouts
- Stream drops retried; hung tools and silent streams time out; progress saved each iteration
- Context compaction preserves the original task and tool-call pairing
- Repeated text in context, empty-reply stalls, cut-off tool arguments, lost output tails
- Tool-success reporting, daemon lock and duplicate-start issues, Discord drops, OpenRouter registration

---

## v4.0.0 (2026-09-03) — Apex

### Windows-First Runtime Portability
- Replaced Unix-only shell assumptions in core execution tools with platform-aware shell dispatch
- Added shared runtime helpers for app home, config discovery, IPC keyring lookup, Python launch, and shell execution
- Removed hardcoded `/etc`, `/usr/bin/chromium`, `/bin/bash`, `/home/...`, and raw `/tmp/...` assumptions from key runtime paths
- Preserved legacy `symbiote` paths for compatibility while preferring current Symbiote runtime locations

### Installer & Launch Flow Cleanup
- Hardened launcher/runtime assets for Windows, Linux, and macOS
- Improved browser sidecar startup so packaged and cross-platform installs can resolve Python and browser paths correctly
- Aligned setup defaults with portable app data locations for new installs

### Release & Packaging Prep
- Aligned package metadata and runtime version reporting to **v4.0.0 Apex**
- Refreshed release surfaces and static landing assets for public packaging and deployment handoff
- Updated installation guidance to use the npm package name

---

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
- See: [Circuit Breaker](docs/core-conepts/circuit-breaker.md)

### Session Hot Resume
- Session state persisted to disk every 60s
- On process termination: all active sessions marked and flushed to disk before exit
- Startup restoration: previous session state reloaded on boot with 24h age validation
- Gateway restarts no longer lose conversation context registration
- See: [Sessions](docs/core-conepts/sessions.md)

### Metrics Collector
- Provider metrics: call count, error count, token usage (in/out), latency histograms (p50/p90/p99)
- Tool metrics: per-tool call frequency, latency, error rates
- Session metrics: turn count, active session tracking
- Ring buffer design: bounded memory, automatic eviction of old samples
- Auto-flush to JSON every 5 minutes; zero dependencies (pure Node.js stdlib)
- See: [Metrics](docs/core-conepts/metrics.md)

### Configurable Idle Emoji
- Idle status indicator emoji now configurable via `idleEmoji` field in `symbiote.json`
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
