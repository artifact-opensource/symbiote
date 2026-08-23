# Release Notes - v3.0.0 Apex

## Symbiote v3.0.0 Apex - Production Hardening + Installer Overhaul

**Date:** August 23, 2026

This release closes production gaps across API exposure, sub-agent control, installation, versioning, and deployment assets. It also introduces a professional desktop installer UI and a shared setup flow used by both the terminal and browser-based installers.

### Production Hardening

- **HTTP API authentication is enforced** for both `/api/v1/chat` and `/api/chat`
- **HTTP API now binds to configurable hosts** and defaults to loopback-safe settings
- **Loopback-only web root serving** blocks remote access to the embedded web UI on the API port
- **HTTP request owner impersonation is prevented** unless identity is IPC-verified
- **Config validation now runs before startup and reload** so broken production config is rejected early

### Sub-Agent Reliability

- **Real depth tracking** for nested sub-agents
- **Working kill semantics** via abort signals
- **Working steering semantics** via controlled abort + resume
- **Sub-agents no longer inherit owner/admin privileges** by accident

### Installer & Setup

- **New desktop installer UI** via `symbiote init --ui`
- **New double-click launchers**: `install.command` and `install.cmd`
- **Shared guided setup core** powers both CLI and desktop installer flows
- **CLI install flow now installs, builds, configures, and launches**
- **WhatsApp-enabled CLI installs start in the foreground** so the QR code is visible during pairing
- **Existing `.env` secrets are preserved** during guided reconfiguration

### Launchers & Deployment Assets

- Added `symbiote.sh` and `symbiote.ps1`
- Added `symbiote-gateway.service`
- Repaired legacy `mach6.*` wrappers for compatibility
- Fixed browser sidecar path resolution for packaged/runtime installs

### Version Alignment

- Runtime components now read the version from `package.json`
- CLI, gateway, MCP bridge, metrics, and web status endpoints now report a single version
- Release metadata aligned to **v3.0.0 Apex**

### Upgrade Path

```bash
git pull origin main
npm install
npm run build
symbiote install
```

### Notes

- Existing `mach6.json` deployments remain compatible
- New installs should prefer the `symbiote-*` launcher and service assets
