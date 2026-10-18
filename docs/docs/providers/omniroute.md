# OmniRoute Provider

OmniRoute is a multi-provider routing layer that aggregates access to various LLM providers through a single API.

## Configuration

```json
{
  "provider": "omniroute",
  "omniroute": {
    "apiKey": "${OMNIROUTE_API_KEY}",
    "model": "anthropic/claude-3.5-sonnet"
  }
}
```

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `OMNIROUTE_API_KEY` | Yes | API key from OmniRoute |

## Notes

- Routes requests to underlying providers (similar to OpenRouter).
- Check OmniRoute documentation for supported models and pricing.
