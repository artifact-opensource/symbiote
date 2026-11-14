# Symbiote Releases

The latest release is **v6.0.0**. Post-release work is listed under [Unreleased](CHANGELOG.md#unreleased) until it receives a versioned release.

## Latest: v6.0.0 (November 15, 2026)
The Legacy Gateway release removes Electron, starts the Gateway directly, centralizes session storage, and provides a Windows MSI that installs the Gateway service with a bundled Node.js runtime. Details: [Release Notes](docs/releases/RELEASE_NOTES_v6.0.0.md).

## v5.7.1 (November 7, 2026)
Stability and Gateway reliability improvements, Cloudflare context-window budgeting, provider discovery and hot-swapping, and local Artifact Engine support. Details: [Release Notes](docs/releases/RELEASE_NOTES_v5.7.1.md).

## v5.7.0 Apex (November 2, 2026)
Introduces the connector engine, agent-enabled Markets workspace, optional local neural memory, OpenSky-backed resource aggregation, provider discovery, and a gateway-supervised recovery UI. Details: [Release Notes](docs/releases/RELEASE_NOTES_v5.7.0.md).

## v5.6.2 Apex (October 29, 2026)
Hardened Windows shortcut, wizard, and source-install flows; added on-demand update checks and MSI download progress; improved runtime, session, heartbeat, integration, and workspace reliability. Details: [Release Notes](docs/releases/RELEASE_NOTES_v5.6.2.md).

## v5.6.1 Apex (October 25, 2026)
Fixed duplicate assistant history and completion events, hardened session persistence and process startup/output handling, and constrained SARSI routing to configured provider/model choices. Details: [Release Notes](docs/releases/RELEASE_NOTES_v5.6.1.md).

## v5.6.0 Apex (October 23, 2026)
HttpMcpBridge integration for remote n8n connections, WhatsApp QR support in GatewayStatus, enhanced health telemetry with provider call tracking, stabilized Electron gateway lifecycle, UI/UX refinements, and idempotency metadata for all tool definitions. Details: [Changelog](CHANGELOG.md).

## v5.5.0 Apex (October 17, 2026)
Project-scoped agent operations and project memory, a redesigned workspace hierarchy, system GPU/per-core CPU telemetry, consistent slider-controlled appearance, weighted memory similarity, and hardened Discord streaming and Windows telemetry. Details: [Changelog](CHANGELOG.md).

## All Releases

| Version | Date | Highlights |
|---------|------|-----------|
| **v6.0.0 Legacy Gateway** | Nov 15, 2026 | Electron removal, direct Gateway startup, centralized sessions, Windows service MSI, native Git and connectors |
| **v5.7.1** | Nov 7, 2026 | Gateway/Electron stability, Cloudflare context budgeting, provider discovery and hot-swapping, Artifact Engine |
| **v5.7.0 Apex** | Nov 2, 2026 | Connectors, Markets, neural memory, public resource aggregation, provider discovery, recovery UI, production automation |
| **v5.6.2 Apex** | Oct 29, 2026 | Windows launch and setup hardening, update progress, runtime and UI reliability |
| **v5.6.1 Apex** | Oct 25, 2026 | Runner and history duplication fixes, session persistence hardening, process error handling, configured SARSI routes |
| **v5.6.0 Apex** | Oct 23, 2026 | Remote n8n integration, WhatsApp QR setup, health telemetry, Electron lifecycle and UI refinements |
| **v5.5.0 Apex** | Oct 17, 2026 | Project operations and memory, hero hierarchy, GPU/per-core CPU metrics, shared appearance, weighted similarity, Windows telemetry and Discord streaming fixes |
| **v5.3.0 Apex** | Oct 12, 2026 | Ops Memory, Windows shell diagnostics, Discord progress limits and redaction, persistence and retry hardening |
| **v5.2.0 Apex** | Oct 10, 2026 | Admin tools, Windows shell, injection guard rebuild, loop reliability, Curator bug detection, Memograph |
| **v4.0.0 Apex** | Sep 3, 2026 | Windows-first runtime fixes, installer cleanup, packaging prep, docs + landing overhaul |
| **v3.0.0 Apex** | Aug 23, 2026 | Production hardening, desktop installer UI, CLI install overhaul, release alignment |
| **v2.1.0** | Mar 12, 2026 | Circuit breaker failover, hot resume, metrics, health endpoint |
| **v2.0.0** | Mar 12, 2026 | Rebrand, IPC identity, Playwright tools, VDB, voice, installers |
| **v1.6.0** | Mar 7, 2026 | Native Gemini, 8 providers, multi-user deployment |
| **v1.5.0** | Mar 6, 2026 | Blink, Pulse, COMB, 7 providers |
| **v1.4.0** | Mar 5, 2026 | MCP server, anti-loop, degradation protection |
| **v1.3.0** | Mar 3, 2026 | Multi-bot coordination, ATM, sibling yield |
| **v1.2.0** | Feb 28, 2026 | Multi-bot coordination, echo loop prevention |
| **v1.1.0** | Feb 28, 2026 | Brand kit, first-time setup flow, first npm publish |
| **v1.0.0** | Feb 28, 2026 | First stable: Discord, WhatsApp, HTTP API, 18 tools, 4 providers |

## Changelog

Full changelog with detailed changes and upgrade notes: [CHANGELOG.md](CHANGELOG.md)
