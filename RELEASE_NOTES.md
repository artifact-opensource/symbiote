# Release Notes - v4.0.0 Apex

## Symbiote v4.0.0 Apex - Windows-First Hardening + Packaging Prep

**Date:** September 3, 2026

This release prepares Symbiote for broader production deployment and public packaging by fixing Windows-first runtime issues, cleaning up cross-platform paths, tightening installer/runtime flows, and refreshing release assets.

### Windows-First Runtime Fixes

- **Core shell tools now use platform-aware shells** instead of assuming `sh -c`
- **Background process execution is portable** across Windows, Linux, and macOS
- **IPC keyring lookup no longer assumes `/etc/mach6`** and now respects portable app-home resolution
- **Copilot token cache paths are unified** through shared runtime path helpers
- **Voice reply temp files use `os.tmpdir()`** instead of raw Unix temp paths

### Web Automation & Tooling

- **Playwright sidecar startup now resolves Python portably**
- **Chromium path is configurable** instead of hardcoded to `/usr/bin/chromium`
- **Encrypted browser profile permissions are applied only where supported**
- **Edge TTS execution no longer depends on `/bin/bash` activation flows**

### Installer, Launchers, and Packaging

- Hardened packaged/runtime asset discovery for installer and browser flows
- Preserved legacy `mach6` compatibility while preparing current Symbiote release assets
- Updated install guidance to use **`npm install -g symbiote`**
- Prepared the repository for **v4.0.0 Apex** packaging and maintainer release publishing

### Release Handoff

- **Suggested tag:** `v4.0.0`
- **Suggested release title:** `v4.0.0 Apex`
- **Publish note:** create the Git tag and GitHub release from a maintainer environment, then attach these release notes as the release body
