# Groq Provider

Fastest inference available — 280-1000 tok/sec on Groq's custom LPU (Language Processing Unit) hardware. **Free tier available.** OpenAI-compatible API.

> **Recommended for getting started.** Free tier, no credit card, fastest inference in the market.

## Setup

1. Get an API key at [console.groq.com/keys](https://console.groq.com/keys)
2. Add it to your `.env`:

```bash
# .env
GROQ_API_KEY=gsk_...
```

3. Configure in `mach6.json`:

```json
{
  "defaultProvider": "groq",
  "defaultModel": "llama-3.3-70b-versatile",
  "providers": {
    "groq": {
      "baseUrl": "https://api.groq.com/openai"
    }
  }
}
```

## Configuration Options

| Option | Default | Description |
|--------|---------|-------------|
| `apiKey` | `$GROQ_API_KEY` | API key (env var recommended) |
| `baseUrl` | `https://api.groq.com/openai` | Groq API endpoint |

## Supported Models

| Model | Config Value | Notes |
|-------|-------------|-------|
| Llama 3.3 70B | `llama-3.3-70b-versatile` | Best all-around **(default)** |
| Llama 3.1 8B | `llama-3.1-8b-instant` | Ultra-fast, lighter tasks |
| Mixtral 8x7B | `mixtral-8x7b-32768` | 32K context MoE model |

Any model listed on Groq's [supported models page](https://console.groq.com/docs/models) can be used — just set the model ID in `defaultModel`.

## Rate Limit Handling

Symbiote automatically handles Groq's rate limits:

- Parses the `try again in Xs` delay from Groq's 429 error responses
- Retries up to 3 times with the server-specified delay + 500ms buffer
- Falls back to a 15-second default delay if the server doesn't specify one
- Non-429 errors are thrown immediately (no retry)

This makes the free tier practical for real usage — rate limits are absorbed transparently.

## Example

```json
{
  "defaultProvider": "groq",
  "defaultModel": "llama-3.3-70b-versatile",
  "providers": {
    "groq": {}
  }
}
```

```bash
GROQ_API_KEY=gsk_your_key_here
```

Switch mid-session:

```
/provider groq
/model llama-3.1-8b-instant
```
