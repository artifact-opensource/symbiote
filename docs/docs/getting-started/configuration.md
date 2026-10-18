# Configuration

Symbiote uses `symbiote.json` for agent settings and `.env` for secrets. Run `symbiote upgrade` to bring an older file to the current format. Editors that support JSON Schema get completion and validation from the bundled `symbiote.schema.json`.

## symbiote.json

The setup flow writes every section below. Values shown are the defaults.

```jsonc
{
  "$schema": "./symbiote.schema.json",
  "configVersion": 2,

  "name": "Symbiote",
  "emoji": "",

  // Model
  "defaultProvider": "openrouter",
  "defaultModel": "openrouter/free",
  "fallbackProviders": [],
  "temperature": 0.7,
  "maxTokens": 8192,
  "maxIterations": 50,
  "adaptiveTemperature": { "adaptive": false, "default": 0.5, "logChanges": false },

  // Paths are relative to this file
  "workspace": ".",
  "sessionsDir": ".session",
  "ownerIds": [],

  // Network
  "apiHost": "127.0.0.1",
  "apiPort": 3006,
  "webHost": "0.0.0.0",
  "webPort": 3009,
  "allowedOrigins": ["http://127.0.0.1:3009", "http://localhost:3009"],

  // Runtime
  "toolProgress": true,
  "tools": { "enabled": true },
  "timeouts": { "llmRequestMs": 900000 },
  "heartbeat": { "activeIntervalMin": 30, "idleIntervalMin": 120, "sleepingIntervalMin": 360, "quietHoursStart": 23, "quietHoursEnd": 8 },

  // Secrets are ${VAR} references resolved from .env
  "providers": {
    "openrouter": { "baseUrl": "https://openrouter.ai/api/v1", "apiKey": "${OPENROUTER_API_KEY}", "timeoutMs": 600000 },
    "anthropic": { "apiKey": "${ANTHROPIC_API_KEY}" },
    "openai": { "apiKey": "${OPENAI_API_KEY}" },
    "gemini": { "apiKey": "${GEMINI_API_KEY}" },
    "groq": { "baseUrl": "https://api.groq.com/openai", "apiKey": "${GROQ_API_KEY}" },
    "xai": { "apiKey": "${XAI_API_KEY}" },
    "nvidia": { "apiKey": "${NVIDIA_API_KEY}" },
    "github-copilot": {},
    "ollama": { "baseUrl": "http://127.0.0.1:11434" }
  },

  "discord": { "enabled": false, "token": "${DISCORD_BOT_TOKEN}", "botId": "${DISCORD_CLIENT_ID}", "policy": { "dmPolicy": "allowlist", "groupPolicy": "mention-only", "requireMention": true, "allowedSenders": [], "allowedGroups": [], "ownerIds": [] } },
  "whatsapp": { "enabled": false, "authDir": "~/.symbiote/whatsapp-auth", "autoRead": true, "markOnline": true, "policy": { "dmPolicy": "allowlist", "groupPolicy": "mention-only", "allowedSenders": [], "allowedGroups": [], "ownerIds": [] } },

  "orchestrator": { "enabled": false }
}
```

### Environment Variable Interpolation

All string values in `symbiote.json` support `${ENV_VAR}` syntax:

```json
{
  "discord": {
    "token": "${DISCORD_BOT_TOKEN}",
    "botId": "${DISCORD_CLIENT_ID}"
  }
}
```

Variables are resolved from `process.env` at load time. The `.env` file is auto-loaded by the built-in dotenv loader.

## Environment file (`.env`)

Copy `.env.example` to `.env`, or let `symbiote init` create it. Add credentials only for the providers and channels you plan to use. Keep `.env` private and never commit it.

```bash
# LLM providers: set the key for each provider you use
OPENROUTER_API_KEY=
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
GEMINI_API_KEY=
GROQ_API_KEY=
XAI_API_KEY=
NVIDIA_API_KEY=

# GitHub Copilot: optional; `gh auth login` can provide credentials automatically
COPILOT_GITHUB_TOKEN=

# Discord: fill these in if Discord is enabled in symbiote.json
DISCORD_BOT_TOKEN=
DISCORD_CLIENT_ID=

# HTTP API: set this key to enable the authenticated HTTP API
SYMBIOTE_API_KEY=
SYMBIOTE_WEB_HOST=0.0.0.0
SYMBIOTE_WEB_TOKEN=

# Ollama runs locally and does not need an API key.
# Optional runtime settings:
# SYMBIOTE_LOG=debug
# SYMBIOTE_SANDBOX=1
# SYMBIOTE_INJECTION_GUARD=strict
# SYMBIOTE_SHELL=
```

> Install with `npm i @symbiote-agi/symbiote`, then run `npx symbiote init` for the guided CLI setup or `npx symbiote init --ui` for the desktop installer UI. See [Setup Flow](wizard.md).

## Key Settings

| Setting           | Type   | Default             | Description                                                                             |
| ----------------- | ------ | ------------------- | --------------------------------------------------------------------------------------- |
| `defaultProvider` | string | `"openrouter"`      | Active LLM provider                                                                     |
| `defaultModel`    | string | `"openrouter/free"` | Active model                                                                            |
| `maxTokens`       | number | `8192`              | Max tokens per response                                                                 |
| `maxIterations`   | number | `50`                | Max tool-call loops per turn                                                            |
| `temperature`     | number | `0.7`               | Response temperature (0.0–1.2)                                                          |
| `workspace`       | string | `cwd()`             | Agent's file system root                                                                |
| `sessionsDir`     | string | `".session"`        | Session persistence directory; runtime session files are kept in `<workspace>/.session` |
| `apiHost`         | string | `"127.0.0.1"`       | HTTP API bind host                                                                      |
| `apiPort`         | number | `3006`              | HTTP API port                                                                           |
| `webHost`         | string | `"0.0.0.0"`         | Web Control Room bind host                                                              |
| `webPort`         | number | `3009`              | Web UI port                                                                             |

## Web UI Configuration

The Web UI runs on a separate port from the HTTP API:

```jsonc
{
  "apiPort": 3006,         // HTTP API (agent runner, channels)
  "webPort": 3009          // Web UI (browser chat interface)
}
```

The web UI listens on all interfaces by default and protects LAN control requests with a generated token stored at `<workspace>/.session/web-access-token`. Set `SYMBIOTE_WEB_TOKEN` to provide a custom token. Configure `webHost`, `webPort`, `apiHost`, and `apiPort` in `symbiote.json`; the HTTP API and Control Room use separate endpoints. See [Web UI](../channels/webchat.md) for details.

## VDB And Memograph

VDB (embedded persistent memory) works out of the box with zero configuration. The `.vdb/` directory is created automatically in the agent's workspace.

Session ingestion follows `<workspace>/.session`. Set `MEMOGRAPH_STORAGE_DIR` to import graph snapshots from a custom path. Imported LIVE/PROJECT/ENTERPRISE shards keep separate namespaces, permissions, and topology metadata. Dense embeddings are not generated by the default VDB.

Advanced VDB tuning is done at the code level:

| Setting              | Default | Description                                 |
| -------------------- | ------- | ------------------------------------------- |
| Idle timeout         | 5 min   | Evict in-memory index after inactivity      |
| Auto-ingest interval | 10 min  | Minimum time between session auto-ingestion |
| Storage format       | JSONL   | Append-only, crash-safe                     |

See [VDB](../../core/vdb.md) and [Memograph Integration](../core-concepts/memograph.md) for retrieval and topology details.

## Voice Configuration

The voice pipeline auto-detects voice messages and handles them transparently. No configuration required for basic operation.

For enterprise deployments with sovereign voice (MeloTTS + OpenVoice), the voice scripts are configured via environment-specific paths in the voice middleware source.

See [Voice Pipeline](../../core/voice.md) for details.

## Provider Configuration

Each provider can be configured with:

| Option    | Description                                     |
| --------- | ----------------------------------------------- |
| `apiKey`  | Override env var (not recommended — use `.env`) |
| `baseUrl` | Custom endpoint URL                             |

See [Providers Overview](../providers/overview.md) for supported providers and their options.

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

| Policy           | Options                        | Description                            |
| ---------------- | ------------------------------ | -------------------------------------- |
| `dmPolicy`       | `allowlist`, `open`            | Who can DM the bot                     |
| `groupPolicy`    | `mention-only`, `open`, `deny` | How the bot responds in servers        |
| `requireMention` | boolean                        | Whether @mention is required in groups |
| `allowedSenders` | string\[]                      | User IDs with DM access                |
| `allowedGroups`  | string\[]                      | Channel/group IDs the bot responds in  |

## Hot Reload

Reload configuration without restarting the daemon:

```bash
# Linux/macOS
kill -USR1 $(pgrep -f "gateway/daemon.js")
```

> **Note:** `SIGUSR1` hot-reload is not available on Windows. Restart the process to apply config changes.

## Validation

Symbiote validates configuration at [boot](../core-concepts/boot-sequence.md) with human-readable diagnostics. Missing required fields, invalid types, and unreachable providers are caught before the agent starts — not at runtime.
