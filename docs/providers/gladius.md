# Gladius Provider

Gladius is Artifact Virtual's local AI kernel. It provides a fully local inference endpoint — no cloud, no API keys, your hardware.

## Setup

```json
{
  "providers": {
    "gladius": {
      "baseUrl": "http://127.0.0.1:8741"
    }
  }
}
```

Start the Gladius server before launching Symbiote. The provider communicates via OpenAI-compatible HTTP API.

## Configuration Options

| Option | Default | Description |
|--------|---------|-------------|
| `baseUrl` | `http://127.0.0.1:8741` | Gladius server endpoint |
| `timeoutMs` | 120000 | Request timeout |

## Use Cases

- **Local operation** — no internet required, full offline capability
- **Provider failover** — fall back to Gladius when cloud providers are unavailable
- **Privacy-sensitive workloads** — data never leaves your machine
- **Development** — test agent behavior without consuming cloud API credits

## Failover

Configure Gladius as a failover provider:

```json
{
  "defaultProvider": "github-copilot",
  "providers": {
    "github-copilot": {},
    "gladius": { "baseUrl": "http://127.0.0.1:8741" }
  }
}
```

If the primary provider fails, switch to Gladius with `/provider gladius`.
