# Symbiote v5.5.0 — Apex

**Release date:** October 17, 2026

Symbiote 5.5 brings project work into the agent workflow, makes workspace memory relationships easier to understand, and improves visibility into the host running the Gateway. Appearance controls now carry through the hero and main page accents, while Discord streaming and Windows telemetry receive additional reliability safeguards.

## Highlights

### Project-centered agent operations

- Track project scope, tasks, progress, and agent assignments in the project workspace.
- Edit and archive projects, and choose from available projects directly in the Agent IDE.
- Index project files as a distinct project-memory collection alongside knowledge and session history.

### More useful system telemetry

- Replace the dashboard's process-memory card with GPU adapter load and memory metrics when supported by the operating system.
- Show CPU utilization by logical core over time, in addition to total CPU usage.
- Report GPU telemetry as unavailable when no supported adapter or operating-system counters are exposed.
- Bound Windows counter queries, prevent overlapping GPU refreshes, and retry transient failures without waiting through an extended backoff.

### Clearer workspace and memory maps

- Arrange the hero graph outward from the main agent through conversations, projects, agents, and subagents; project relationships remain connected to their parent.
- Rank sparse-vector memory neighbors using inverse-document-frequency-weighted cosine similarity.
- Keep graph links bounded and symmetric, and visually distinguish knowledge, session, project, and vector-store sources.
- Apply the selected primary hue to the hero and page headings in both light and dark appearance modes.

### More reliable integrations

- Serialize Discord streaming edits to prevent duplicate or out-of-order progress messages.
- Avoid noisy expected registry errors while resolving Node on Windows.

## Upgrade

No configuration migration is required. For a source checkout, install dependencies and rebuild:

```powershell
npm ci
npm run build
```
