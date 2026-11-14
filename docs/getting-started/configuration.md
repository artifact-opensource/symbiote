# Configuration

Symbiote uses `symbiote.json` for agent settings and `.env` for secrets. Run `symbiote upgrade` to bring an older file to the current format. Editors that support JSON Schema get completion and validation from the bundled `symbiote.schema.json`.

## symbiote.json

The setup flow writes every section below. Values shown are the defaults.

```jsonc
{
  "$schema": "./symbiote.schema.json",
  "configVersion": 2,

  "name": "Symbiote",
  "emoji": "bot",

  // Model
  "defaultProvider": "openrouter",
  "defaultModel": "openrouter/free",
  "fallbackProviders": [],
  "temperature": 0.7,
  "maxTokens": 8192,
  "maxIterations": 100,
  "adaptiveTemperature": { "adaptive": false, "default": 0.5, "logChanges": false },

  // Paths are relative to this file
  "workspace": ".",
  "sessionsDir": ".sessions",
  "ownerIds": [],

  // Network
  "apiHost": "127.0.0.1",
  "apiPort": 3006,
  "webHost": "0.0.0.0",
  "webPort": 3009,
  "xmcpPort": 9999,
  "allowedOrigins": ["http://127.0.0.1:3009", "http://localhost:3009"],

  // Runtime
  "toolProgress": true,
  "tools": { "enabled": true },
  "sandbox": {
    "enabled": true,
    "ownerAccess": true,
    "internalTier": "standard",
    "nonOwnerTier": "restricted"
  },
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
    "cloudflare": {
      "accountId": "${CLOUDFLARE_ACCOUNT_ID}",
      "apiKey": "${CLOUDFLARE_API_TOKEN}",
      "model": "@cf/zai-org/glm-4.7-flash",
      "models": [
        "@cf/zai-org/glm-4.7-flash",
        "@cf/zai-org/glm-5.3-flash",
        "@cf/openai/gpt-oss-20b",
        "@cf/qwen/qwen3-30b-a3b-fp8",
        "@cf/deepseek-ai/deepseek-v4-flash-0731"
      ]
    },
    "github-copilot": {},
    "ollama": { "baseUrl": "http://127.0.0.1:11434" }
  },
  "sarsiProviders": ["cloudflare"],

  "discord": { "enabled": false, "token": "${DISCORD_BOT_TOKEN}", "botId": "${DISCORD_CLIENT_ID}", "policy": { "dmPolicy": "allowlist", "groupPolicy": "mention-only", "requireMention": true, "allowedSenders": [], "allowedGroups": [], "ownerIds": [] } },
  "whatsapp": { "enabled": false, "authDir": "~/.symbiote/whatsapp-auth", "autoRead": true, "markOnline": true, "policy": { "dmPolicy": "allowlist", "groupPolicy": "mention-only", "allowedSenders": [], "allowedGroups": [], "ownerIds": [] } },

  "orchestrator": { "enabled": false }
}
```

### Optional neural memory

The lexical VDB remains available by default. To add dense retrieval, use an embedding-capable model exposed by Artifact Engine (or retain an existing Ollama setup) and configure:

```json
{
  "memory": {
    "neural": {
      "enabled": true,
      "provider": "artifact-engine",
      "baseUrl": "http://127.0.0.1:8080/v1",
      "model": "YOUR_LOADED_MODEL_ID",
      "lexicalWeight": 0.4,
      "denseWeight": 0.6,
      "temporalHalfLifeDays": 180
    }
  }
}
```

Artifact Engine's model id is returned by `GET /v1/models`. Its local GGUF server provides embeddings by mean-pooling and L2-normalizing final-layer token states, so use a model designed or validated for embeddings; this is not equivalent to a dedicated embedding head. The existing Ollama endpoint remains supported for migrated configurations.

For legacy Ollama deployments, set `provider` to `ollama`, use its server origin as `baseUrl`, and choose an installed embedding model such as `bge-m3`. Symbiote keeps the original VDB records and backfills a separate model-specific dense index; switching providers or models does not discard lexical memories.

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

### Sandbox and owner access

`ownerIds` identifies trusted users; channel allowlists control who may interact but do not by themselves grant owner privileges. With the sandbox enabled, verified owners can receive admin-tier tool access when `ownerAccess` is true. Other users use `nonOwnerTier`, internal runs use `internalTier`, and sub-agents inherit their parent's tier. Both tier settings accept `standard` or `restricted`.

Setting `sandbox.enabled` to `false` gives internal sessions and their agents admin-tier tool access, with shell commands defaulting to the agent's assigned workspace. Verified channel owners retain admin access. External non-owners remain restricted; this is an application policy layer, not an OS container. Use this configuration only for a trusted, single-operator deployment.

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
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_API_TOKEN=

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

> Install with `npm i @symbiote-agi/symbiote`, then run `npx symbiote init` for the guided CLI setup or `npx symbiote init --ui` for the browser-based setup UI. See [Setup Flow](wizard.md).

## Key Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `defaultProvider` | string | `"openrouter"` | Active LLM provider |
| `defaultModel` | string | `"openrouter/free"` | Active model |
| `maxTokens` | number | `8192` | Max tokens per response |
| `maxIterations` | number | `100` | Starting iteration budget per runner invocation; Pulse expands sustained work to 1,000 and Blink continues across invocations |
| `temperature` | number | `0.7` | Response temperature (0.0–1.2) |
| `workspace` | string | `cwd()` | Agent's file system root |
| `sessionsDir` | string | `".sessions"` | Legacy session path; session data is consolidated under `<workspace>/.sessions` |
| `apiHost` | string | `"127.0.0.1"` | HTTP API bind host |
| `apiPort` | number | `3006` | HTTP API port |
| `webHost` | string | `"0.0.0.0"` | Web Control Room bind host |
| `webPort` | number | `3009` | React webapp port |
| `xmcpPort` | number | `9999` | Standalone xMCP HTTP server port |

Provider blocks may set `maxTokens` to cap generated output and `contextWindow` to declare the selected model's total context limit. When configured, the runner reserves room for output and tool definitions, then trims older conversation history to fit the remaining prompt budget. Set these values for the actual model and account limits; published catalog claims can differ from the effective API limit. See [Cloudflare Workers AI configuration](../providers/cloudflare.md#configuration).

## Web UI Configuration

The Web UI runs on a separate port from the HTTP API:

```jsonc
{
  "apiPort": 3006,         // HTTP API (agent runner, channels)
  "webPort": 3009,         // React webapp
  "xmcpPort": 9999         // Standalone xMCP service
}
```

The web UI listens on all interfaces by default and protects LAN control requests with a generated token stored at `<workspace>/.sessions/web-access-token`. Set `SYMBIOTE_WEB_TOKEN` to provide a custom token. Configure `webHost`, `webPort`, `apiHost`, and `apiPort` in `symbiote.json`; the HTTP API and Control Room use separate endpoints. See [Web UI](../channels/webchat.md) for details.

Enabling Tailscale-only access changes the Gateway's external bind to the connected Tailscale address while retaining a loopback listener for local health checks. Other tailnet devices still need the web access token.

## VDB And Memograph

VDB (embedded persistent memory) works out of the box with zero configuration. The `.vdb/` directory is created automatically in the agent's workspace.

Session ingestion follows `<workspace>/.sessions`. Set `MEMOGRAPH_STORAGE_DIR` to import graph snapshots from a custom path. Imported LIVE/PROJECT/ENTERPRISE shards keep separate namespaces, permissions, and topology metadata. Dense embeddings are not generated by the default VDB.

Advanced VDB tuning is done at the code level:

| Setting | Default | Description |
|---------|---------|-------------|
| Idle timeout | 5 min | Evict in-memory index after inactivity |
| Auto-ingest interval | 10 min | Minimum time between session auto-ingestion |
| Storage format | JSONL | Append-only, crash-safe |

See [VDB](../core-conepts/vdb.md) and [Memograph Integration](../core-conepts/memograph.md) for retrieval and topology details.

## Voice Configuration

The voice pipeline auto-detects voice messages and handles them transparently. No configuration required for basic operation.

For enterprise deployments with sovereign voice (MeloTTS + OpenVoice), the voice scripts are configured via environment-specific paths in the voice middleware source.

See [Voice Pipeline](../core-conepts/voice.md) for details.

## Provider Configuration

Each provider can be configured with:

| Option | Description |
|--------|-------------|
| `apiKey` | Override env var (not recommended — use `.env`) |
| `accountId` | Cloudflare account ID; use `CLOUDFLARE_ACCOUNT_ID` in `.env` |
| `baseUrl` | Custom endpoint URL |
| `models` | Explicit model IDs permitted for SARSI routing |
| `maxTokens` | Provider-specific maximum output tokens |
| `contextWindow` | Total model context limit used to budget conversation history |

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

Symbiote validates configuration at [boot](../core-conepts/boot-sequence.md) with human-readable diagnostics. Missing required fields, invalid types, and unreachable providers are reported before the agent starts.
