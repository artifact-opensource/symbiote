# Providers Overview

Symbiote supports 8 LLM providers through a unified streaming interface. Providers are hot-swappable mid-session — switch models without losing conversation context.

## Supported Providers

| Provider | Config Key | Auth Method | GPU Required | Speed |
|----------|-----------|-------------|--------------|-------|
| [Groq](groq.md) | `groq` | `GROQ_API_KEY` env var | No | ⚡ Fastest |
| [Anthropic](anthropic.md) | `anthropic` | `ANTHROPIC_API_KEY` env var | No | Fast |
| [OpenAI](openai.md) | `openai` | `OPENAI_API_KEY` env var | No | Fast |
| [Gemini](gemini.md) | `gemini` | `GEMINI_API_KEY` env var | No | Fast |
| [xAI (Grok)](xai.md) | `xai` | `XAI_API_KEY` env var | No | Fast |
| [GitHub Copilot](github-copilot.md) | `github-copilot` | Auto-resolved from `gh` CLI | No | Moderate |
| [Ollama](ollama.md) | `ollama` | None (local) | Optional | Varies |
| [Gladius](gladius.md) | `gladius` | Local HTTP endpoint | Optional | Local |

> **Default provider:** Groq — free tier, 280-1000 tok/sec, no credit card needed. [Get a key →](https://console.groq.com/keys)

## Configuration

Register providers in `mach6.json`:

```json
{
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
  "defaultProvider": "groq",
  "defaultModel": "llama-3.3-70b-versatile"
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

- **Rate limits (429)** — parses server-specified retry delay, retries up to 3 times
- **Buffer** — adds 500ms to the server-specified delay to avoid hitting the limit again immediately
- **Fallback delay** — 10-15 seconds if the server doesn't specify a retry window
- **Non-429 errors** — thrown immediately, no retry

## Diagnostics

Symbiote validates provider configuration at boot. Missing API keys, unreachable endpoints, and invalid configurations are caught during the [boot sequence](../core/boot-sequence.md) — not at runtime. Failed providers log warnings but don't prevent startup if they aren't the default.
