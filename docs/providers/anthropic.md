# Anthropic Provider

Direct access to Anthropic's Claude models via their API.

## Setup

```bash
# .env
ANTHROPIC_API_KEY=sk-ant-...
```

```json
{
  "providers": {
    "anthropic": {}
  }
}
```

## Configuration Options

| Option | Default | Description |
|--------|---------|-------------|
| `apiKey` | `$ANTHROPIC_API_KEY` | API key (env var recommended) |
| `baseUrl` | Anthropic default | Custom endpoint URL |
| `timeoutMs` | 120000 | Request timeout |

## Supported Models

Any model available through the Anthropic API, including:

- `claude-opus-4-20250514`
- `claude-sonnet-4-20250514`
- `claude-haiku-3-20250307`

Specify the model in `defaultModel` or switch mid-session with `/model`.
