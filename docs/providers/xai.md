# xAI (Grok) Provider

Access to xAI's Grok models — strong reasoning with fast inference. OpenAI-compatible API.

## Setup

1. Get an API key at [console.x.ai](https://console.x.ai/)
2. Add it to your `.env`:

```bash
# .env
XAI_API_KEY=xai-...
```

3. Configure in `mach6.json`:

```json
{
  "defaultProvider": "xai",
  "defaultModel": "grok-3-fast",
  "providers": {
    "xai": {}
  }
}
```

## Configuration Options

| Option | Default | Description |
|--------|---------|-------------|
| `apiKey` | `$XAI_API_KEY` | API key (env var recommended) |
| `baseUrl` | `https://api.x.ai/v1` | xAI API endpoint |

## Supported Models

| Model | Config Value | Notes |
|-------|-------------|-------|
| Grok 3 | `grok-3` | Strongest reasoning |
| Grok 3 Fast | `grok-3-fast` | Balanced speed + quality |
| Grok 3 Mini | `grok-3-mini` | Lightweight with think mode |
| Grok 3 Mini Fast | `grok-3-mini-fast` | Fastest Grok model |

## Rate Limit Handling

Same retry logic as other OpenAI-compatible providers:

- Parses `try again in Xs` from 429 error responses
- Retries up to 3 times with server-specified delay + 500ms buffer
- Default retry delay: 10 seconds
- Non-429 errors thrown immediately

## Example

```json
{
  "defaultProvider": "xai",
  "defaultModel": "grok-3-fast",
  "providers": {
    "xai": {}
  }
}
```

```bash
XAI_API_KEY=xai-your_key_here
```

Switch mid-session:

```
/provider xai
/model grok-3
```
