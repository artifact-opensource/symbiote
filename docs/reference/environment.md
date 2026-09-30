# Environment Variables

All environment variables used by Symbiote. Set these in `.env` (auto-loaded at startup) or your shell environment.

## LLM Providers

| Variable | Required | Description |
|----------|----------|-------------|
| `GROQ_API_KEY` | If using Groq | Groq API key (`gsk_...`). [Get one](https://console.groq.com/keys) |
| `ANTHROPIC_API_KEY` | If using Anthropic | Anthropic API key (`sk-ant-...`) |
| `OPENAI_API_KEY` | If using OpenAI | OpenAI API key (`sk-...`) |
| `GEMINI_API_KEY` | If using Gemini | Google Gemini API key (`AIza...`). [Get one](https://aistudio.google.com/apikey) |
| `XAI_API_KEY` | If using xAI | xAI API key (`xai-...`) |
| `COPILOT_GITHUB_TOKEN` | No | GitHub Copilot token (auto-resolved if `gh` CLI is authenticated) |
| `GH_TOKEN` | No | GitHub token (fallback for Copilot) |
| `GITHUB_TOKEN` | No | GitHub token (fallback for Copilot) |

## Discord

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_BOT_TOKEN` | If using Discord | Discord bot token |
| `DISCORD_CLIENT_ID` | If using Discord | Discord bot application ID |

## HTTP API

| Variable | Required | Description |
|----------|----------|-------------|
| `MACH6_API_KEY` | If using HTTP API | Bearer token for API authentication |
| `MACH6_PORT` | No | HTTP API port (default: `3006`) |

## Workspace

| Variable | Required | Description |
|----------|----------|-------------|
| `MACH6_WORKSPACE` | No | Override workspace path (default: `cwd()`) |

## Resolution Order

Environment variables can be set in:

1. **`.env` file** - auto-loaded at startup via built-in dotenv loader (recommended for secrets)
2. **Shell environment** - `export VAR=value`
3. **systemd service** - `Environment=VAR=value`
4. **`mach6.json`** - via `${VAR}` interpolation in string values

`.env` values do not override existing shell environment variables.

## Provider-Specific Auth

| Provider | Key Variable | Fallback |
|----------|-------------|----------|
| Groq | `GROQ_API_KEY` | None - required |
| Anthropic | `ANTHROPIC_API_KEY` | None - required |
| OpenAI | `OPENAI_API_KEY` | None - required |
| Gemini | `GEMINI_API_KEY` | None - required |
| xAI | `XAI_API_KEY` | None - required |
| GitHub Copilot | `COPILOT_GITHUB_TOKEN` | `GH_TOKEN` > `GITHUB_TOKEN` > `gh auth token` CLI > config files |
| Ollama | None | No auth needed (local) |
| Gladius | None | No auth needed (local) |
