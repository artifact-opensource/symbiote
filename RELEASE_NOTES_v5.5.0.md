# Symbiote v5.5.0 — Apex

**Release date:** October 17, 2026
**Compare:** [v5.3.0...v5.5.0](https://github.com/artifact-opensource/symbiote/compare/v5.3.0...v5.5.0)

Symbiote 5.5 is a major workspace and runtime release. It rebuilds the Control Room and Electron desktop experience around live agent operations, adds project-aware work and memory, expands the agent's integrations and tools, and delivers a Windows service installer. It also improves host telemetry, memory visualization, Discord streaming, and recovery across the desktop and gateway.

## Highlights

### Rebuilt Control Room and desktop app

- Reworked the web Control Room and Electron desktop shell into a live workspace for monitoring and operating the Symbiote runtime.
- Added a live workspace clock and uptime dial, runtime health and setup surfaces, and clearer desktop-to-Gateway lifecycle handling.
- Added dedicated views for projects, the agent IDE, integrations, scheduled work, conversation threads, games, and memory.
- Improved the shared visual system, responsive layouts, and appearance controls so the selected brightness and primary color carry through the application.

### Project-aware agent work

- Added project workspaces with project identity, scoped context, editable project details, and project task tracking.
- Track scope, task status and progress, agent assignment, and work remaining from the project workspace.
- Select projects from the Agent IDE and run project-scoped work, including terminal tasks, without globally activating a project just to inspect it.
- Index project files as a distinct memory collection and connect projects into workspace and memory visualizations.

### Expanded agent tools and integrations

- Added scheduled and recurring work through the cron manager and its Control Room panel.
- Added persistent conversation threads and workspace task operations.
- Added speech-to-text, image-generation, Google Workspace, and cloud-integration tools and supporting setup surfaces.
- Added an ArtifactEngine provider configuration option and improved OpenRouter setup guidance.
- Restored Discord slash commands and skill handlers; improved browser interaction and Windows Git Bash path handling.

### Windows deployment and portable runtime

- Added a Windows x64 MSI installer for deploying Symbiote Gateway as a Windows service, with install, firewall, and uninstall scripts.
- Improved runtime setup and service lifecycle handling for the desktop app and Gateway, including recovery of Discord credentials from configured sources.
- Added release workflows for build/test validation and platform release artifacts.
- Kept Linux and macOS source installation available through the npm package and source archives; the GitHub release provides source `.tar.gz` and `.zip` archives.

### Memory, visualization, and host telemetry

- Added per-logical-core CPU history and GPU adapter load/memory metrics; GPU is reported as unavailable when the host exposes no supported telemetry.
- Improved Windows counter collection with bounded queries, non-overlapping GPU refreshes, and recovery from transient sampling failures.
- Rebuilt the workspace hero visualization around connected routes from the main agent through conversations/projects to agents and subagents.
- Added project nodes to the memory map and clarified the knowledge, sessions, projects, and vector-store source families.
- Improved sparse-vector neighbor ranking with inverse-document-frequency-weighted cosine similarity and bounded, symmetric graph links.

### Reliability and hardening

- Serialize Discord streaming edits to prevent duplicate, stale, or out-of-order progress messages.
- Hardened long-running agent and workspace recovery, project IDE behavior, and credential handling.
- Improved SVG safety and input sanitization, and tightened runtime/tool handling.
- Avoid expected Windows registry lookup noise when resolving Node.

## Downloads

- **Windows x64:** [Symbiote-5.5.0-x64.msi](https://github.com/artifact-opensource/symbiote/releases/download/v5.5.0/Symbiote-5.5.0-x64.msi)
- **MSI SHA-256:** `DC15DC3B92EC1BE53719EE0AFDF57353CAA89B753369CDBA83F97C6D9EFA91DF`
- **Source archive (tar.gz):** [symbiote-5.5.0-source.tar.gz](https://github.com/artifact-opensource/symbiote/releases/download/v5.5.0/symbiote-5.5.0-source.tar.gz)
- **Source archive (zip):** [symbiote-5.5.0-source.zip](https://github.com/artifact-opensource/symbiote/releases/download/v5.5.0/symbiote-5.5.0-source.zip)
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
