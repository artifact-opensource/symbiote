# Providers Overview

Symbiote's CLI and gateway registries expose 10 LLM providers through a unified streaming interface. Providers are hot-swappable mid-session — switch models without losing conversation context. A routed provider is selected only when it is registered and configured; otherwise the configured default is used.

## Supported Providers

| Provider | Config Key | Auth Method | GPU Required | Speed |
|----------|-----------|-------------|--------------|-------|
| [OpenRouter](openrouter.md) | `openrouter` | `OPENROUTER_API_KEY` | No | Varies |
| [Anthropic](anthropic.md) | `anthropic` | `ANTHROPIC_API_KEY` | No | Fast |
| [OpenAI](openai.md) | `openai` | `OPENAI_API_KEY` | No | Fast |
| [Groq](groq.md) | `groq` | `GROQ_API_KEY` | No | Fast |
| [Gemini](gemini.md) | `gemini` | `GEMINI_API_KEY` | No | Fast |
| [xAI (Grok)](xai.md) | `xai` | `XAI_API_KEY` | No | Fast |
| [GitHub Copilot](github-copilot.md) | `github-copilot` | `gh auth` | No | Varies |
| [Ollama](ollama.md) | `ollama` | Local service | Optional | Varies |
| [Gladius](gladius.md) | `gladius` | Local HTTP endpoint | Optional | Local |
| NVIDIA | `nvidia` | `NVIDIA_API_KEY` | No | Varies |

Provider modules for Qwen, AI Horde, FreeAI, and OmniRoute exist in source but are not currently registered for CLI/gateway selection.

> **Default provider:** OpenRouter (`openrouter/free`). Set `OPENROUTER_API_KEY` in `.env` or configure `providers.openrouter.apiKey`.

## Configuration

Register providers in `symbiote.json`:

```json
{
  "providers": {
    "openrouter": { "baseUrl": "https://openrouter.ai/api/v1" },
    "groq": { "baseUrl": "https://api.groq.com/openai" },
    "anthropic": {},
    "openai": {},
    "gemini": {},
    "xai": {},
    "ollama": { "baseUrl": "http://127.0.0.1:11434" },
    "github-copilot": {},
    "gladius": { "baseUrl": "http://127.0.0.1:8741" }
  },
  "defaultProvider": "openrouter",
  "defaultModel": "openrouter/free"
}
```

Only configured providers are available. Omit a provider to disable it.

## Hot-Swapping

Switch provider or model mid-session:

```
/provider anthropic
/model claude-sonnet-4
```

The session's conversation history carries over. The new provider picks up where the old one left off.

## Provider Interface

All providers implement the same streaming interface:

```typescript
interface Provider {
  name: string;
  stream(
    messages: Message[],
    tools: ToolDef[],
    config: ProviderConfig,
  ): AsyncIterable<StreamEvent>;
}
```

Groq, xAI, and Ollama are built on the OpenAI-compatible adapter — they use the same streaming protocol with provider-specific base URLs and authentication.

## Retry Logic

All OpenAI-compatible providers (Groq, xAI, Ollama, OpenAI) include automatic retry:

- **Rate limits (429)** — observes `Retry-After`, with bounded backoff for temporary limits
- **Daily quota** — fails fast because retrying before quota reset cannot help
- **Authentication (401)** — fails fast; providers do not share credential-refresh behavior
- **Server errors (5xx)** — bounded retry with backoff

## Diagnostics

Symbiote validates provider configuration at boot. Missing API keys, unreachable endpoints, and invalid configurations are caught during the [boot sequence](../core/boot-sequence.md) — not at runtime. Failed providers log warnings but don't prevent startup if they aren't the default.
