# FreeAI Provider

FreeAI provides free-tier access to multiple LLM models through a single API endpoint.

## Configuration

```json
{
  "provider": "freeai",
  "freeai": {
    "apiKey": "${FREEAI_API_KEY}",
    "model": "gpt-4o-mini"
  }
}
```

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `FREEAI_API_KEY` | Yes | API key from the FreeAI service |

## Notes

- Free tier with rate limits.
- Good for development and testing.
- Model availability may change.
