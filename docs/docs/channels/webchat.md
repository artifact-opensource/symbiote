# Web Control Room

Symbiote includes a browser-based control room for working with the configured project workspace, agent conversations, task runs, subagents, and runtime health.

## Access

Open `http://localhost:3009` on the machine running the gateway. The web server defaults to listening on all interfaces; `webPort` is configurable in `symbiote.json` (default: `3009`). From another device on the same network, open `http://<gateway-lan-ip>:3009`.

LAN control requests require a bearer token. On first startup, Symbiote creates a random token at `<workspace>/.session/web-access-token`; open **Configuration → Connect another device** on the gateway host to reveal and copy it. The token is only exposed to same-origin requests from the local control room and is stored in the remote browser tab's session storage. Alternatively, set `SYMBIOTE_WEB_TOKEN` to a secret of at least 32 characters. Do not share the token or expose the service on an untrusted network. The static UI can load without a token, but session, agent, task, configuration, and log APIs remain protected. Local loopback use does not require a token.

On Windows, Electron checks for an existing firewall rule and, if none is present, asks before adding optional LAN access. Approval triggers the Windows elevation prompt and limits inbound access to the configured TCP port from the local subnet on Domain and Private networks. Declining or cancelling elevation leaves the gateway and desktop app usable on the host; LAN access stays blocked by the firewall. The choice can be revisited from **Configuration** in the desktop app. The MSI does not change the firewall during installation; see [Production Deployment](../advanced/production.md).

The Electron app is a desktop shell for the gateway-served Control Room and connects to the configured web port over loopback. It does not start a separate runtime or bypass the LAN token. Other devices still connect to the gateway's LAN address and need the access token; Windows firewall access is optional and can be enabled later from the desktop **Configuration** page.

## Workspace tasks

From **Workspace**, submit a task name and prompt to send it through the selected conversation's existing session and the normal agent pipeline and tool sandbox. Each new conversation gets its own session file. The **Runs** view shows task briefs, lifecycle status, subagent counts, tools used, errors, and transcript links. Active runs can be stopped, restarted, or guided.

Run state is persisted with the conversation. If the gateway restarts while a run is still marked running, startup marks it failed and preserves its transcript; it does not automatically resume an interrupted turn. Archiving a conversation moves its session file into `.session/archive/` rather than deleting it.

## Subagents

The **Agents** view lists subagents created by Symbiote's `spawn` tool. Each subagent gets a unique session and the normal AGI system prompt, with its task context added. It displays status, task, parent session, result, and errors. Active agents can be stopped or sent steering guidance, and continue to use the gateway's existing session-scoped sandbox and inherited tool policy.

The Workspace hero visualizes the main agent, direct conversations, and outward project branches with their agents and subagents. Project nodes open project details; they do not change the active conversation or agent context. Select a conversation node to open its transcript or a subagent node to open its conversation.

## Projects and Agent IDE

Create a project from the **Projects** drawer. Selecting a project opens its management view without changing the active conversation or agent. Project details include editable scope and success criteria, agent and run counts, task progress, task creation, status, and agent assignment. Projects can be archived and restored; permanent deletion is available only for archived projects and removes their stored workspace data.

Open **Agent IDE** from the right rail to choose from all active projects. The IDE's project choice is local to the IDE and does not switch the project used by Conversations or Agents. Each project has a separate workspace under `<workspace>/.agents/projects/<id>/workspace` and project-scoped agents and sessions. The IDE browses, creates, edits, moves, and deletes project files and folders; the editor accepts files up to 1 MB. It omits `.env` files, `.git`, `node_modules`, `.session`, and `.agents` from the browser. Destructive file actions require confirmation.

The project manager and IDE **Plan** panel share project tasks with pending, in-progress, completed, and blocked states. Tasks can be assigned to agents belonging to that project. Agents can use the same project task list while working. Each IDE terminal tab owns a persistent shell process rooted in that project's workspace; commands and output stream through the Gateway, and each submitted command is checked by the configured tool sandbox. These are pipe-backed shells, not pseudo-terminals, so terminal UI applications that require a TTY are not supported. Closing a tab, leaving the IDE, archiving the project, or shutting down the Gateway stops its shell.

## Scheduled work and agent threads

Open **Cron** in the workspace drawer to create one-time reminders or recurring jobs. Recurring schedules use five-field cron expressions in the gateway machine's local time zone. Due jobs start autonomous agent runs using the configured tools and sandbox; the panel shows run alerts and allows failed alerts to be retried. Review prompts carefully before enabling schedules, since jobs can perform external or destructive actions if their instructions and tool policy permit them.

**Threads** provides persistent agent collaboration. Threads can be scoped to a project, selected agents, all agents, or an invited external contact. Agents can post, mention collaborators, mark posts read, and react. A dedicated user-help request is raised when an agent is blocked; it appears as an unread item in Threads and can produce an optional browser notification. Ordinary thread posts do not alert the user or start another agent run. User-created threads, external contacts, and thread content are stored locally under `<workspace>/.threads/`.

## Shared appearance and release notices

The sliders control adjusts brightness (from AMOLED black to full light) and the primary and accent hues. These settings are stored by the gateway under `<workspace>/.agents/appearance.json` and shared by Control Room browser tabs and Electron; browser-local values provide a fallback while connecting.

When the gateway can reach GitHub, it checks the latest stable release at startup and periodically afterward. If a newer version is found, the Control Room links to its release page. This is a notice only: Symbiote does not download or install updates automatically. Offline or failed checks do not prevent the gateway from running.

## Games

The **Zen** entry in the sidebar opens the games area. Its game tabs are registered in the web UI so new games can be added alongside Chess. Chess is played against a built-in opponent with five difficulty levels; **Adaptive** selects a level from the player's rating. Legal moves are enforced by `chess.js`. Match results update an Elo rating (K-factor 32), which in turn informs adaptive difficulty. The current position, difficulty, rating, result, and recent match history are persisted by the gateway in `<workspace>/.session/games/chess-state.json`, shared by the web UI and Electron and retained across restarts.

## Conversations and operations

* **Conversations** provides the session chat interface and Markdown transcript export.
* **Browser** provides a Playwright-controlled page with navigation, screenshots, and mouse/keyboard actions.
* **Session history** searches saved conversations.
* **Memory** visualizes indexed knowledge and session records on separate sides of the Symbiote node. Similar records are grouped into topical shards without merging the underlying documents; links show sparse lexical-vector similarity, not embedding-based semantic similarity. Select a record for its indexed text, filter or search the map, and export the current view as a PNG.
* **Operations** shows channel/provider health, whole-host CPU and memory use, network and disk I/O, available temperature sensors, resource warnings, and recent gateway logs. Temperature is reported only when the operating system exposes a sensor; unavailable sensors are not estimated.
* **Notifications** prioritizes runtime alerts and attention items in the control room. Optional native browser notifications require browser permission and a secure context; this is not an offline Web Push service.
* **Tool registry** lists tools available to the runtime.
* **Integrations** configures optional Google Workspace, Azure, OCI, local n8n (or an explicitly configured remote instance), and Kaggle connections. See [Google Workspace](../integrations/google-workspace.md) and [Cloud Integrations](../integrations/cloud-integrations.md) for setup and access limits.
* **Configuration** displays runtime settings without allowing web-based edits; on the gateway host it can reveal the LAN access token and, in Electron on Windows, configure the optional firewall rule.
* Light and dark themes are available; brightness and palette settings are shared through the gateway.

The Memory map is built from the shared VDB and `.session/` history. At startup, session JSON files are recursively ingested, including archived transcripts; new active-session turns are added by the VDB pulse. Only user and assistant text is indexed from sessions, not system prompts or tool messages. Similarity is calculated from the VDB's sparse term-frequency vectors, so it represents lexical overlap rather than dense-embedding semantics.

## Session storage

All runtime session files are stored under `<workspace>/.session/`. Existing configured session directories and `.sessions/` data are migrated there at startup. Archives remain under `.session/archive/`.

## Control API

| Endpoint                      | Method   | Description                                         |
| ----------------------------- | -------- | --------------------------------------------------- |
| `/api/status`                 | GET      | Runtime and channel health                          |
| `/api/config`                 | GET      | Read-only effective configuration                   |
| `/api/sessions`               | GET      | List saved sessions                                 |
| `/api/sessions`               | POST     | Create a conversation session                       |
| `/api/sessions/:id`           | DELETE   | Archive a conversation session                      |
| `/api/sessions/:id/messages`  | GET      | Read a saved transcript                             |
| `/api/chat`                   | POST     | Send a conversation message                         |
| `/api/runs`                   | GET      | List persisted workspace task runs                  |
| `/api/runs`                   | POST     | Start a task run                                    |
| `/api/runs/:id/stop`          | POST     | Stop an active workspace run                        |
| `/api/agents`                 | GET      | List runtime subagents                              |
| `/api/agents/:id/action`      | POST     | Stop or steer an active subagent                    |
| `/api/browser/snapshot`       | GET      | Read the controlled browser page and screenshot     |
| `/api/browser/navigate`       | POST     | Navigate the controlled browser                     |
| `/api/browser/action`         | POST     | Send a mouse or keyboard action                     |
| `/api/games/chess`            | GET, PUT | Read or persist shared Chess state                  |
| `/api/sessions/:id/interrupt` | POST     | Interrupt an active conversation turn               |
| `/api/memory/graph`           | GET      | Read the indexed memory graph and similarity links  |
| `/api/memory/documents/:id`   | GET      | Read an indexed memory record                       |
| `/api/appearance`             | GET, PUT | Read or update shared appearance settings           |
| `/api/tools`                  | GET      | List available tools                                |
| `/api/logs`                   | GET      | Read the recent gateway log tail                    |
| `/api/access`                 | GET      | Check whether this browser needs LAN authentication |

## Development

```bash
npm --prefix webapp run dev
```

The Vite development server proxies `/api` requests to `http://127.0.0.1:3009`; run the gateway locally for API-backed features.

Build the web UI with:

```bash
npm --prefix webapp run build
```
