# HTTP API

Symbiote exposes a REST API for programmatic access. The same agent pipeline handles HTTP requests as Discord and WhatsApp messages.

## Endpoints

### POST `/api/v1/chat`

Send a message and receive the agent's response.

**Headers:**
```
Authorization: Bearer <MACH6_API_KEY>
Content-Type: application/json
```

**Request:**
```json
{
  "text": "What files are in the workspace?",
  "sessionId": "my-session",
  "senderId": "api-user"
}
```

**Response (JSON):**
```json
{
  "text": "Here are the files in your workspace:\n- README.md\n- src/\n- package.json",
  "sessionId": "my-session",
  "toolCalls": [
    { "name": "exec", "input": { "command": "ls" } }
  ]
}
```

**Response (SSE):**

Add `Accept: text/event-stream` for streaming:

```
data: {"type":"text_delta","content":"Here are"}
data: {"type":"text_delta","content":" the files"}
data: {"type":"tool_start","name":"exec"}
data: {"type":"tool_end","name":"exec","result":"README.md\nsrc/\npackage.json"}
data: {"type":"done"}
```

### GET `/api/v1/health`

Gateway health check.

```json
{
  "status": "ok",
  "uptime": 3600,
  "channels": { "discord": "connected", "whatsapp": "connected" },
  "provider": "github-copilot",
  "model": "claude-opus-4-6"
}
```

### POST `/api/v1/relay`

Relay a message to WhatsApp (bridge mode).

```json
{
  "target": "1234567890@s.whatsapp.net",
  "text": "Hello from the API"
}
```

## Authentication

Set `MACH6_API_KEY` in your `.env` file. All API requests require a valid Bearer token.

```bash
MACH6_API_KEY=your-secret-key
```

## Web UI

The built-in web interface is served at the same port (`http://localhost:3006`):

- Session management — create, switch, delete
- Streaming responses with tool call visualization
- Config panel — change provider, model, temperature live
- Sub-agent monitoring — view and kill running sub-agents
- Generative UI — file reads, exec outputs render as rich cards

No build step. No npm dependencies. Single static HTML file.

## CORS

Configure allowed origins:

```jsonc
{
  "api": {
    "allowedOrigins": ["https://yourdomain.com"]
  }
}
```

Default: `["*"]` (all origins allowed).
