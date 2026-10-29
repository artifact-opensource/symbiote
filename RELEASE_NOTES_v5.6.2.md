# Symbiote v5.6.2 — Apex

**Released October 29, 2026**

This patch improves Windows launching, setup, and the in-app update experience, alongside runtime and Control Room reliability fixes.

## Added

- Added a manual update check in the Control Room and visible progress while a verified Windows MSI is downloaded.
- Added safe recovery states for setup when its preferred local port is already in use.

## Changed

- Source installers now use the root and webapp lockfiles, provision the Electron and web build runtimes, and build the Windows shortcut launcher.
- Release publishing selects release notes from the pushed version tag.
- Improved runtime, session, heartbeat, integration, and workspace reliability.

## Fixed

- Removed the Windows shortcut launcher's unconditional administrator relaunch.
- Prevented installer defaults from returning existing provider or Discord secrets to the browser.
- Restricted installer requests to the loopback origin, limited request bodies, and returned actionable client errors.
- Improved installer loading, save, and network error handling and prevented duplicate submissions.

## Upgrade notes

- No configuration migration is required.
- From a source checkout, run `npm ci`, `npm --prefix webapp ci`, then `npm run build`.
- Windows users can check for updates from the Control Room. The downloaded MSI is validated against the published SHA-256 manifest before installation.
