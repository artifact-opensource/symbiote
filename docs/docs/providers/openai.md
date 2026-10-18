# OpenAI Provider

Direct access to OpenAI's models via their API.

## Setup

```bash
# .env
OPENAI_API_KEY=sk-...
```

```json
{
  "providers": {
    "openai": {}
  }
}
```

## Configuration Options

| Option | Default | Description |
|--------|---------|-------------|
| `apiKey` | `$OPENAI_API_KEY` | API key (env var recommended) |
| `baseUrl` | OpenAI default | Custom endpoint URL |
| `timeoutMs` | 120000 | Request timeout |

## Supported Models

Any model available through the OpenAI API, including:

- `gpt-4o`
- `gpt-4-turbo`
- `o3-mini`

Specify the model in `defaultModel` or switch mid-session with `/model`.
