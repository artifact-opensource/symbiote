# Web Control Room

Symbiote includes a browser-based control room for working with the configured project workspace, agent conversations, task runs, subagents, and runtime health.

## Access

Open `http://localhost:3009` on the machine running the gateway. The web server defaults to listening on all interfaces; `webPort` is configurable in `symbiote.json` (default: `3009`). From another device on the same network, open `http://<gateway-lan-ip>:3009`.

LAN control requests require a bearer token. On first startup, Symbiote creates a random token at `<workspace>/.session/web-access-token`; open **Configuration → Connect another device** on the gateway host to reveal and copy it. The token is only exposed to same-origin requests from the local control room and is stored in the remote browser tab's session storage. Alternatively, set `SYMBIOTE_WEB_TOKEN` to a secret of at least 32 characters. Do not share the token or expose the service on an untrusted network. The static UI can load without a token, but session, agent, task, configuration, and log APIs remain protected. Local loopback use does not require a token.

## Workspace tasks

From **Workspace**, submit a task name and prompt to send it through the selected conversation's existing session and the normal agent pipeline and tool sandbox. Each new conversation gets its own session file. The **Runs** view shows task briefs, lifecycle status, subagent counts, tools used, errors, and transcript links. Active runs can be stopped, restarted, or guided.

Run state is persisted with the conversation. If the gateway restarts while a run is still marked running, startup marks it failed and preserves its transcript; it does not automatically resume an interrupted turn. Archiving a conversation moves its session file into `.session/archive/` rather than deleting it.

## Subagents

The **Agents** view lists subagents created by Symbiote's `spawn` tool. Each subagent gets a unique session and the normal AGI system prompt, with its task context added. It displays status, task, parent session, result, and errors. Active agents can be stopped or sent steering guidance, and continue to use the gateway's existing session-scoped sandbox and inherited tool policy.

The Workspace hero visualizes the main agent, web conversations, and their subagents. Select a conversation node to open its transcript or a subagent node to open agent controls.

## Games

The **Zen** entry in the sidebar opens the games area. Its game tabs are registered in the web UI so new games can be added alongside Chess. Chess is played against a built-in opponent with five difficulty levels; **Adaptive** selects a level from the player's rating. Legal moves are enforced by `chess.js`. Match results update an Elo rating (K-factor 32), which in turn informs adaptive difficulty. The current position, difficulty, rating, result, and recent match history are persisted by the gateway in `<workspace>/.session/games/chess-state.json`, shared by the web UI and Electron and retained across restarts.

## Conversations and operations

- **Conversations** provides the session chat interface and Markdown transcript export.
- **Browser** provides a Playwright-controlled page with navigation, screenshots, and mouse/keyboard actions.
- **Session history** searches saved conversations.
- **Memory** visualizes indexed knowledge and session records on separate sides of the Symbiote node. Similar records are grouped into topical shards without merging the underlying documents; links show sparse lexical-vector similarity, not embedding-based semantic similarity. Select a record for its indexed text, filter or search the map, and export the current view as a PNG.
- **Operations** shows channel/provider health, whole-host CPU and memory use, network and disk I/O, available temperature sensors, resource warnings, and recent gateway logs. Temperature is reported only when the operating system exposes a sensor; unavailable sensors are not estimated.
- **Notifications** prioritizes runtime alerts and attention items in the control room. Optional native browser notifications require browser permission and a secure context; this is not an offline Web Push service.
- **Tool registry** lists tools available to the runtime.
- **Configuration** displays runtime settings without allowing web-based edits.
- Light and dark themes are available and persist in the browser.

The Memory map is built from the shared VDB and `.session/` history. At startup, session JSON files are recursively ingested, including archived transcripts; new active-session turns are added by the VDB pulse. Only user and assistant text is indexed from sessions, not system prompts or tool messages. Similarity is calculated from the VDB's sparse term-frequency vectors, so it represents lexical overlap rather than dense-embedding semantics.

## Session storage

All runtime session files are stored under `<workspace>/.session/`. Existing configured session directories and `.sessions/` data are migrated there at startup. Archives remain under `.session/archive/`.

## Control API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/status` | GET | Runtime and channel health |
| `/api/config` | GET | Read-only effective configuration |
| `/api/sessions` | GET | List saved sessions |
| `/api/sessions` | POST | Create a conversation session |
| `/api/sessions/:id` | DELETE | Archive a conversation session |
| `/api/sessions/:id/messages` | GET | Read a saved transcript |
| `/api/chat` | POST | Send a conversation message |
| `/api/runs` | GET | List persisted workspace task runs |
| `/api/runs` | POST | Start a task run |
| `/api/runs/:id/stop` | POST | Stop an active workspace run |
| `/api/agents` | GET | List runtime subagents |
| `/api/agents/:id/action` | POST | Stop or steer an active subagent |
| `/api/browser/snapshot` | GET | Read the controlled browser page and screenshot |
| `/api/browser/navigate` | POST | Navigate the controlled browser |
| `/api/browser/action` | POST | Send a mouse or keyboard action |
| `/api/games/chess` | GET, PUT | Read or persist shared Chess state |
| `/api/sessions/:id/interrupt` | POST | Interrupt an active conversation turn |
| `/api/memory/graph` | GET | Read the indexed memory graph and similarity links |
| `/api/memory/documents/:id` | GET | Read an indexed memory record |
| `/api/tools` | GET | List available tools |
| `/api/logs` | GET | Read the recent gateway log tail |
| `/api/access` | GET | Check whether this browser needs LAN authentication |

## Development

```bash
npm --prefix webapp run dev
```

The Vite development server proxies `/api` requests to `http://127.0.0.1:3009`; run the gateway locally for API-backed features.

Build the web UI with:

```bash
npm --prefix webapp run build
```
