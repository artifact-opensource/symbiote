# Symbiote v5.6.0 — Apex

**Release date:** October 23, 2026
**Compare:** [v5.5.0...v5.6.0](https://github.com/artifact-opensource/symbiote/compare/v5.5.0...v5.6.0)

Symbiote 5.6 is a minor release focused on enhanced integrations, improved health telemetry, and UI/UX refinements. It adds HttpMcpBridge support for remote n8n connections, expands gateway status with WhatsApp QR support, and stabilizes the Electron gateway lifecycle.

## Highlights

### Enhanced integrations and MCP bridge

- **HttpMcpBridge integration:** added support for remote n8n connections through the HttpMcpBridge, enhancing MCP server handling for external workflow orchestration.
- **WhatsApp QR support:** added WhatsApp QR code display to the GatewayStatus channel tiles for streamlined WhatsApp channel setup.

### Health telemetry and gateway improvements

- **Enhanced health telemetry:** improved gateway issue tracking and added provider call tracking with gateway lifecycle events for better observability.
- **Gateway lifecycle stabilization:** stabilized the Electron gateway lifecycle for more reliable desktop-to-Gateway communication.
- **Activity states:** updated activity states and enhanced UI components for improved runtime visibility.

### UI/UX refinements

- **HeroAgentOrb:** enhanced responsiveness and fixed dimension/style consistency issues.
- **Workspace hero graph:** fixed overflow issues and improved graph interaction styling.
- **Uptime stopwatch and channel tiles:** updated styles for improved visual consistency.
- **General UI components:** updated styles and components across the application for improved UX.

### Tool reliability

- **Idempotency metadata:** added idempotency metadata to all 62 tool definitions across 51 tool files, improving tool execution reliability and preventing duplicate operations.
- **OpenRouter key propagation:** fixed stale OpenRouter key propagation to ensure credentials are correctly refreshed.

### Documentation and cleanup

- Updated documentation files and cleaned up unused code sections.
- Removed release notes for Symbiote v5.3.0.

## Downloads

- **Windows x64:** [Symbiote-5.6.0-x64.msi](https://github.com/artifact-opensource/symbiote/releases/download/v5.6.0/Symbiote-5.6.0-x64.msi)
- **MSI SHA-256:** `TBD`
- **Source archive (tar.gz):** [symbiote-5.6.0-source.tar.gz](https://github.com/artifact-opensource/symbiote/releases/download/v5.6.0/symbiote-5.6.0-source.tar.gz)
- **Source archive (zip):** [symbiote-5.6.0-source.zip](https://github.com/artifact-opensource/symbiote/releases/download/v5.6.0/symbiote-5.6.0-source.zip)
- **Linux and macOS:** build from either source archive. See the installation instructions below.

## Upgrade and installation

No configuration migration is required. Symbiote requires Node.js 20 or newer.

Build from a source checkout or extracted source archive:

```bash
npm ci
npm run build
```

On Windows, run the x64 MSI to install the Gateway service. On Linux and macOS, follow the source installation and daemon instructions in the [installation guide](https://github.com/artifact-opensource/symbiote/blob/master/docs/getting-started/installation.md) and [production deployment guide](https://github.com/artifact-opensource/symbiote/blob/master/docs/advanced/production.md).

## Release artifacts

The release page includes the Windows MSI and source archives (`.tar.gz` and `.zip`). Linux and macOS do not require a separate installer package; install from source.