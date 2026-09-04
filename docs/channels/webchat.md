# Web UI (Webchat)

Built-in web interface for interacting with your Symbiote agent directly from a browser. No build step, no frontend framework — one static HTML file.

## Access

```
http://localhost:3009
```

The port is configurable via `webPort` in `mach6.json` (default: `3009`).

## Features

### Chat Interface

- **Dark glass aesthetic** — void-black background with glass-morphism panels and purple accent lighting
- **Streaming responses** — real-time token streaming via SSE (Server-Sent Events) with animated streaming dots
- **Markdown rendering** — full markdown support with syntax-highlighted code blocks
- **Latency badge** — live provider response time displayed per message
- **Mobile responsive** — adapts to phones and tablets

### Session Management

- **Session sidebar** — create, switch, and delete sessions from the left panel
- **Named sessions** — each session is labeled and persisted
- **Session history** — conversations are preserved across page reloads

### Tool Call Visualization

- **Real-time tool calls** — see which tools the agent is using as they execute
- **Expandable details** — click to see tool inputs and outputs
- **Status indicators** — running, completed, or errored tool calls

### Configuration Panel

- **Provider switching** — change LLM provider on the fly
- **Model selection** — switch models without restarting
- **Temperature control** — adjust creativity in real time
- **API key management** — enter or update provider keys (redacted display)

### Sub-Agent Monitor

- **Active sub-agents** — see spawned sub-agents and their status
- **Progress tracking** — running, completed, or killed states with timestamps

## Architecture

The web UI consists of two parts:

1. **Static HTML** (`web/index.html`) — single file containing all HTML, CSS, and JavaScript. No dependencies, no build step.
2. **Web server** (`src/web/server.ts`) — native Node.js HTTP server with SSE streaming. Proxies chat requests to the agent runner via the HTTP API.

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Serves the web UI HTML |
| `/api/sessions` | GET | List all sessions |
| `/api/sessions` | POST | Create a new session |
| `/api/sessions/:id` | GET | Get session details |
| `/api/sessions/:id` | DELETE | Delete a session |
| `/api/sessions/:id/messages` | POST | Send a message (SSE stream) |
| `/api/config` | GET | Get current config |
| `/api/config` | PUT | Update config |
| `/api/providers` | GET | List available providers |
| `/api/tools` | GET | List available tools |
| `/api/stats` | GET | Runtime statistics |

### SSE Streaming

Chat responses use Server-Sent Events for real-time streaming:

```
event: token
data: {"text": "Hello"}

event: tool_call
data: {"name": "read", "input": {"path": "file.ts"}, "status": "running"}

event: tool_result
data: {"name": "read", "output": "...", "status": "done"}

event: done
data: {"tokensIn": 150, "tokensOut": 89, "latencyMs": 1230}
```

## Configuration

```jsonc
{
  "webPort": 3009,           // Web UI port (default: 3009)
  "apiPort": 3006            // HTTP API port (used internally)
}
```

Agent identity is pulled from `mach6.json`:

```jsonc
{
  "name": "AVA",           // Displayed in the header
  "emoji": "🔮"            // Displayed next to the name
}
```

### Security

By default, the web UI binds to `127.0.0.1` (localhost only). To expose it on the network, use a reverse proxy (nginx, Caddy) with authentication for production deployments.

> **Note:** The web UI shares the same session and tool access as other channels. Any tool available to the agent is available through the web UI.

---

*Added in v1.7.0*
