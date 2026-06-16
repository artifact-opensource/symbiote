# Symbiote — Unified Dashboard

**Symbiote** is the unified web dashboard for the AVA/Symbiote ecosystem. It provides real-time system telemetry, AI-powered image generation, an interactive chat interface, and a modular plugin system.

> **Note:** "Symbiant" is the name of the chat interface within the dashboard. The system itself is called **Symbiote**.

---

## Architecture

```
webapp_old/
├── server.ts           # Express server — API endpoints + static file serving
├── src/
│   ├── App.tsx         # Main React application
│   ├── types.ts        # TypeScript interfaces
│   ├── components/
│   │   └── DiagnosticWidget.tsx  # System telemetry display
│   └── main.tsx        # React entry point
├── index.html          # HTML shell (title: "Symbiote")
├── package.json        # Dependencies & scripts
├── tsconfig.json       # TypeScript config
├── vite.config.ts      # Vite bundler config
├── .env                # Environment variables (GEMINI_API_KEY, etc.)
└── dist/               # Production build output
```

## Features

### 🤖 Chat Interface ("Symbiant")
- Real-time chat powered by the Mach6 gateway (proxied through the webapp server)
- Session-based conversation history persisted in `localStorage`
- Fallback to simulated responses if gateway is unavailable
- **Plugin Design Session**: Special chat mode for designing and building plugins

### 🎨 Neural Art Generation
- **Primary**: [Pollinations.ai](https://pollinations.ai) — free, no API key, ~1s generation
- **Fallback 1**: Gemini 2.5 Flash Image (requires `GEMINI_API_KEY` + quota)
- **Fallback 2**: Procedural SVG generator (always available)
- Configurable aspect ratios: 1:1, 4:3, 3:4, 16:9, 9:16

### 📊 Live System Telemetry
- Real-time CPU load, core count, model name
- RAM usage (total, used, process-level)
- System + process uptime
- Active network interfaces
- Node.js PID and runtime info
- Auto-refreshes every 3 seconds

### 🔌 Plugin System
- 5 built-in plugins: System Monitor, Sensory Feedback, Neural Archives, Vision Projection, Biometric Breath
- Toggle plugins on/off via UI
- **Install New Module**: Opens a guided chat session to design, build, and register custom plugins
- Plugins registered via `/api/plugins/register` endpoint

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | Server status, API availability |
| `GET` | `/api/telemetry` | Full system telemetry (CPU, RAM, uptime, network) |
| `POST` | `/api/generate-image` | Generate AI image from prompt |
| `POST` | `/api/chat` | Chat with the Mach6 gateway |
| `GET` | `/api/plugins` | List all plugin states |
| `POST` | `/api/plugins/toggle` | Toggle a plugin on/off |
| `POST` | `/api/plugins/register` | Register a new plugin |

### POST `/api/generate-image`
```json
{
  "prompt": "a cybernetic owl with golden eyes",
  "aspectRatio": "1:1"
}
```
Returns: `{ "imageUrl": "data:image/jpeg;base64,...", "source": "pollinations", "simulated": false }`

### POST `/api/chat`
```json
{
  "message": "Hello, AVA",
  "sessionId": "optional-session-id"
}
```
Returns: `{ "text": "...", "sessionId": "..." }`

### POST `/api/plugins/register`
```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "description": "Does a thing",
  "author": "Ali",
  "version": "1.0"
}
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GEMINI_API_KEY` | No | Google Gemini API key for image fallback + chat |
| `PORT` | No | Server port (default: `3010`) |
| `NODE_ENV` | No | `production` enables static file serving from `dist/` |
| `GATEWAY_URL` | No | Mach6 gateway URL (default: `http://127.0.0.1:3006`) |
| `MACH6_API_KEY` | No | Mach6 gateway API key |
| `AI_API_KEY` | No | Alternative AI provider key |

## Development

```bash
# Install dependencies
npm install

# Development mode (Vite HMR)
npm run dev

# Production build
npm run build

# Run production server
NODE_ENV=production node dist/server.cjs
```

## Server Ports

| Port | Service | Status |
|------|---------|--------|
| `3010` | Symbiote Dashboard (webapp_old) | **Active** |
| `3009` | Deprecated old web UI | **Deprecated** — port reserved for xmcp |
| `3006` | Mach6 Gateway | Active |

## Dependencies

- `express` — HTTP server
- `@google/genai` — Google Gemini API client
- `vite` — Frontend bundler
- `react` / `react-dom` — UI framework
- `lucide-react` — Icon library
- `motion` — Animation library
- `node-fetch` — HTTP client for image proxying

## License

Artifact Virtual — Internal use.
