# OpenRouter Provider

[OpenRouter](https://openrouter.ai/) is a multi-model aggregator that provides access to hundreds of LLMs through a single API.

## Configuration

```json
{
  "provider": "openrouter",
  "openrouter": {
    "apiKey": "${OPENROUTER_API_KEY}",
    "model": "anthropic/claude-3.5-sonnet"
  }
}
```

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENROUTER_API_KEY` | Yes | API key from openrouter.ai |

## Supported Models

OpenRouter routes to any model it supports. Common choices:

- `anthropic/claude-3.5-sonnet`
- `openai/gpt-4o`
- `google/gemini-pro-1.5`
- `meta-llama/llama-3.1-70b-instruct`
- `x-ai/grok-3`

## Notes

- OpenRouter handles failover across providers automatically.
- Pricing varies per model — check openrouter.ai for current rates.
- Rate limits depend on the underlying provider.
