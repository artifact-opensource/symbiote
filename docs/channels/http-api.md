# HTTP API

Symbiote exposes an authenticated HTTP API and a React browser app. The API server defaults to `127.0.0.1:3006`; the React app defaults to `0.0.0.0:3009`. Configure these with `apiHost`/`apiPort` and `webHost`/`webPort` in `symbiote.json`.

## Authentication

Set `SYMBIOTE_API_KEY` in `.env` and send it as a bearer token for API requests:

```http
Authorization: Bearer your-secret-key
```

`GET /api/v1/health` and `GET /api/status` do not require API authentication. Other API endpoints return `401 Unauthorized` without a valid token. The Control Room has separate access handling: local loopback use does not require a token; remote/LAN control requires the web access token. See [Web Control Room](webchat.md#access).

## Endpoints

### `POST /api/v1/chat`

Send a message through the agent pipeline. The default response is JSON. Set `Accept: text/event-stream` for SSE. Request fields include:

```json
{
  "text": "What files are in the workspace?",
  "sessionId": "my-session",
  "senderId": "api-user"
}
```

The JSON response includes the final text, session ID, and tool calls. SSE can include text deltas, tool lifecycle, reasoning, and completion events, depending on the configured provider.

### `POST /api/chat`

SSE endpoint used by the Control Room. It accepts the same message fields as `/api/v1/chat` and always returns `text/event-stream`. Partial answer text is not streamed; reasoning and tool activity events may be sent, followed by a completion event containing the final response.

### `GET /api/v1/health`

Returns the gateway health payload. The exact fields depend on enabled providers and channels.

### `POST /api/v1/relay`

Relays a message through the configured WhatsApp adapter:

```json
{
  "target": "1234567890@s.whatsapp.net",
  "text": "Hello from the API"
}
```

Returns `501` if relay is not configured.

## Web Control Room

The React/Vite Control Room is served on `webPort` (default `3009`), not `apiPort`. Its project management, Agent IDE, project plan, terminal, and run-monitoring features use the gateway's web control API. The UI is built with `npm run build`; it is not a single static HTML file.

xMCP uses `xmcpPort` (default `9999`) and is a separate process; see [xMCP](../../xmcp/README.md).

## CORS

Configure browser origins with `allowedOrigins`; the default configuration permits the local Control Room origins. CORS is not authentication and should not be treated as an access-control boundary.
