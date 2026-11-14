# Symbiote v6.0.0 - Legacy Gateway

**Release date:** November 15, 2026

This major release returns Symbiote to a Gateway-first deployment. The Gateway and browser-based Control Room remain; the Electron desktop shell is removed.

## Breaking changes

- The Electron app, tray, floating mini-chat, desktop updater, and desktop launcher are no longer included.
- `npm start` now starts the Gateway directly. Open the browser-based Control Room separately.
- The Windows MSI installs the Gateway as an automatically-starting Windows service rather than installing a desktop app.

## Added

- Native Git operations and connectors for supported hosting providers.
- A Windows MSI that bundles a pinned Node.js runtime and service wrapper, installs the Gateway service, and opens browser-based setup.
- CI coverage for Windows MSI installation and uninstallation.

## Changed

- Session storage is centralized under the configured workspace session directory.
- Source installers and release packaging no longer install or build Electron.
- The Gateway CLI provides direct start, stop, restart, and status commands for standalone processes and the Windows service.

## Fixed

- Cloudflare model selection and Discord provider/model fidelity.
- MetaTrader initialization when a terminal path is not configured.
- Windows MSI setup and persistent-data handling.

## Upgrade notes

- Back up `symbiote.json`, `.env`, and `.sessions` before upgrading.
- Close the previous desktop app and stop any running Gateway before installing the MSI. The installer intentionally refuses to replace a Gateway process that is still running.
- The Windows MSI installs service configuration and persistent data under `%ProgramData%\Symbiote`; review the setup page after installation and verify the configured workspace and session directory.
- The Windows service runs independently of the desktop user session. Use the browser-based Control Room to interact with it.
- Source checkouts should use `npm ci`, `npm --prefix webapp ci`, then `npm run build`.
