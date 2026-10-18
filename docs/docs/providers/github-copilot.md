# GitHub Copilot Provider

The default and recommended provider. Uses GitHub's Copilot API proxy to access multiple models without separate API keys.

## Setup

No API key required if the GitHub CLI is installed and authenticated:

```bash
gh auth login
```

That's it. Symbiote resolves the token automatically.

## Token Resolution Order

1. `COPILOT_GITHUB_TOKEN` environment variable
2. `~/.copilot-cli-access-token` file
3. `GH_TOKEN` / `GITHUB_TOKEN` environment variables
4. `~/.config/github-copilot/hosts.json` (Linux/macOS)
5. `%APPDATA%\github-copilot\hosts.json` (Windows)
6. `gh auth token` CLI fallback (all platforms)

## Available Models

| Model | Config Value |
|-------|-------------|
| Claude Opus 4.6 | `claude-opus-4-6` |
| Claude Sonnet 4 | `claude-sonnet-4` |
| GPT-4o | `gpt-4o` |
| o3-mini | `o3-mini` |

## Configuration

```json
{
  "providers": {
    "github-copilot": {}
  },
  "defaultProvider": "github-copilot",
  "defaultModel": "claude-opus-4-6"
}
```

No additional configuration required. The provider handles token refresh automatically.

## Why Copilot?

- **Zero API key management** — uses your existing GitHub authentication
- **Multiple models** — access Claude, GPT-4o, and o3-mini through one endpoint
- **Included with GitHub Copilot subscription** — no per-token billing surprises
