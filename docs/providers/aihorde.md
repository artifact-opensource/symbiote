# AIHorde Provider

[AIHorde](https://aihorde.net/) is a crowdsourced distributed inference network. It's free but slower, as requests are processed by volunteer GPU nodes.

## Configuration

```json
{
  "provider": "aihorde",
  "aihorde": {
    "apiKey": "${AIHORDE_API_KEY}",
    "model": "llama-3.1-70b"
  }
}
```

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `AIHORDE_API_KEY` | No | API key for priority access (anonymous works but slower) |

## Supported Models

Available models depend on what volunteer nodes are running. Check [aihorde.net](https://aihorde.net/) for current model availability.

## Notes

- **Speed:** Slow — requests are queued and processed by volunteer nodes.
- **Cost:** Free.
- **Reliability:** Variable — depends on network capacity.
- Best for testing, development, and non-time-sensitive tasks.
