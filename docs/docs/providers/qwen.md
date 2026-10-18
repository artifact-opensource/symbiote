# Qwen Provider

[Qwen](https://qwenlm.ai/) is Alibaba's LLM family, available via DashScope API.

## Configuration

```json
{
  "provider": "qwen",
  "qwen": {
    "apiKey": "${QWEN_API_KEY}",
    "model": "qwen-max"
  }
}
```

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `QWEN_API_KEY` | Yes | API key from DashScope |

## Supported Models

- `qwen-max` — Most capable, best for complex reasoning
- `qwen-plus` — Balanced performance and cost
- `qwen-turbo` — Fastest, most economical

## Notes

- Qwen models support Chinese and English natively.
- DashScope API is OpenAI-compatible.
