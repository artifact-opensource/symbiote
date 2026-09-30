# Configuration

Symbiote uses two files for configuration: `mach6.json` for agent settings and `.env` for secrets.

## mach6.json

```jsonc
{
  // LLM Settings
  "defaultProvider": "groq",
  "defaultModel": "llama-3.3-70b-versatile",
  "maxTokens": 8192,
  "maxIterations": 50,
  "temperature": 0.3,

  // Workspace — agent's working directory for file operations
  // Use forward slashes on all platforms (Windows: "C:/Users/you/workspace")
  "workspace": "/home/you/workspace",
  "sessionsDir": ".sessions",

  // Provider configuration — all 8 providers
  "providers": {
    "groq": { "baseUrl": "https://api.groq.com/openai" },
    "anthropic": {},
    "openai": {},
    "gemini": {},
    "xai": {},
    "ollama": { "baseUrl": "http://127.0.0.1:11434" },
    "github-copilot": {},
    "gladius": { "baseUrl": "http://127.0.0.1:8741" }
  },

  // Owner IDs — users with full access (bypasses policies)
  "ownerIds": [
    "your-discord-user-id",
    "your-phone@s.whatsapp.net"
  ],

  // Channel configuration (see Channels section for details)
  "discord": { "enabled": true, "..." : "..." },
  "whatsapp": { "enabled": true, "..." : "..." },

  // HTTP API port
  "apiPort": 3006
}
```

### Environment Variable Interpolation

All string values in `mach6.json` support `${ENV_VAR}` syntax:

```json
{
  "discord": {
    "token": "${DISCORD_BOT_TOKEN}",
    "botId": "${DISCORD_CLIENT_ID}"
  }
}
```

Variables are resolved from `process.env` at load time. The `.env` file is auto-loaded by the built-in dotenv loader.

## .env

```bash
# LLM Providers
GROQ_API_KEY=gsk_...           # https://console.groq.com/keys (free tier)
ANTHROPIC_API_KEY=sk-ant-...   # https://console.anthropic.com/
OPENAI_API_KEY=sk-...          # https://platform.openai.com/api-keys
GEMINI_API_KEY=AIza...         # https://aistudio.google.com/apikey
XAI_API_KEY=xai-...            # https://console.x.ai/

# GitHub Copilot — usually automatic via `gh auth login`
# COPILOT_GITHUB_TOKEN=

# Ollama — no key needed, just run `ollama serve`

# Discord
DISCORD_BOT_TOKEN=
DISCORD_CLIENT_ID=

# HTTP API authentication
MACH6_API_KEY=

# Port (default: 3006)
MACH6_PORT=3006
```

> Run `npx symbiote init` for the guided CLI setup, or `npx symbiote init --ui` for the desktop installer UI. See [Setup Flow](wizard.md).

## Key Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `defaultProvider` | string | `"groq"` | Active LLM provider |
| `defaultModel` | string | `"llama-3.3-70b-versatile"` | Active model |
| `maxTokens` | number | `8192` | Max tokens per response |
| `maxIterations` | number | `50` | Max tool-call loops per turn |
| `temperature` | number | `0.3` | Response temperature (0.0–1.2) |
| `workspace` | string | `cwd()` | Agent's file system root |
| `sessionsDir` | string | `".sessions"` | Session persistence directory |
| `apiPort` | number | `3006` | HTTP API port |
| `webPort` | number | `3009` | Web UI port |

## Web UI Configuration

The Web UI runs on a separate port from the HTTP API:

```jsonc
{
  "apiPort": 3006,         // HTTP API (agent runner, channels)
  "webPort": 3009          // Web UI (browser chat interface)
}
```

The web UI binds to `127.0.0.1` by default for security. See [Web UI](../channels/webchat.md) for details.

## VDB Configuration

VDB (embedded persistent memory) works out of the box with zero configuration. The `.vdb/` directory is created automatically in the agent's workspace.

Advanced tuning is done at the code level:

| Setting | Default | Description |
|---------|---------|-------------|
| Idle timeout | 5 min | Evict in-memory index after inactivity |
| Auto-ingest interval | 10 min | Minimum time between session auto-ingestion |
| Storage format | JSONL | Append-only, crash-safe |

See [VDB](../core/vdb.md) for architecture details.

## Voice Configuration

The voice pipeline auto-detects voice messages and handles them transparently. No configuration required for basic operation.

For enterprise deployments with sovereign voice (MeloTTS + OpenVoice), the voice scripts are configured via environment-specific paths in the voice middleware source.

See [Voice Pipeline](../core/voice.md) for details.

## Provider Configuration

Each provider can be configured with:

| Option | Description |
|--------|-------------|
| `apiKey` | Override env var (not recommended — use `.env`) |
| `baseUrl` | Custom endpoint URL |

See [Providers Overview](../providers/overview.md) for all 8 providers and their specific options.

## Channel Policies

Each channel (Discord, WhatsApp) supports granular access control:

```jsonc
{
  "discord": {
    "enabled": true,
    "token": "${DISCORD_BOT_TOKEN}",
    "botId": "${DISCORD_CLIENT_ID}",
    "siblingBotIds": [],        // Other bot IDs to ignore (prevents echo loops)
    "policy": {
      "dmPolicy": "allowlist",       // "allowlist" | "open"
      "groupPolicy": "mention-only", // "mention-only" | "open" | "deny"
      "requireMention": true,
      "allowedSenders": ["your-discord-user-id"],
      "allowedGroups": []
    }
  }
}
```

| Policy | Options | Description |
|--------|---------|-------------|
| `dmPolicy` | `allowlist`, `open` | Who can DM the bot |
| `groupPolicy` | `mention-only`, `open`, `deny` | How the bot responds in servers |
| `requireMention` | boolean | Whether @mention is required in groups |
| `allowedSenders` | string[] | User IDs with DM access |
| `allowedGroups` | string[] | Channel/group IDs the bot responds in |

## Hot Reload

Reload configuration without restarting the daemon:

```bash
# Linux/macOS
kill -USR1 $(pgrep -f "gateway/daemon.js")
```

> **Note:** `SIGUSR1` hot-reload is not available on Windows. Restart the process to apply config changes.

## Validation

Symbiote validates configuration at [boot](../core/boot-sequence.md) with human-readable diagnostics. Missing required fields, invalid types, and unreachable providers are caught before the agent starts — not at runtime.
