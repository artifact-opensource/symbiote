# Agent Creation Wizard

Interactive CLI wizard for first-time setup. Generates all configuration and identity files in one flow.

## Usage

```bash
npx symbiote init
```

Or from source:

```bash
node dist/cli/wizard.js
```

## What It Generates

The wizard creates two configuration files and (optionally) five identity files:

### Configuration Files

| File | Purpose |
|------|---------|
| `symbiote.json` | Agent configuration — provider, model, channels, policies |
| `.env` | Secrets — API keys, bot tokens, API secret |

### Identity Files (optional)

If you choose "Create your AI agent identity," the wizard generates:

| File | Purpose |
|------|---------|
| `SOUL.md` | Agent personality, values, and core truths |
| `IDENTITY.md` | Who the agent is — name, emoji, capabilities |
| `USER.md` | About the human — preferences, personality, notes |
| `AGENTS.md` | Operating protocol — session routines, safety rules |
| `HEARTBEAT.md` | Periodic check configuration |

These files are the agent's memory foundation. The agent reads them at session start to know who it is, who it's helping, and how to operate. Identity files are never overwritten if they already exist.

## Wizard Steps

The wizard walks through 6 steps:

### 1. Agent Identity

- Agent name and emoji
- One-line personality description
- Creator name

### 2. Provider

Choose from 8 providers:

| Provider | Key Needed? | Notes |
|----------|-------------|-------|
| GitHub Copilot | No | Auto-auth via `gh` CLI |
| Anthropic | Yes | Claude models |
| OpenAI | Yes | GPT-4o / o3 |
| Gemini | Yes | Google AI — thinking support, 1M context |
| Ollama | No | Local models, fully offline |
| Groq | Yes | Free tier, fastest inference |
| xAI (Grok) | Yes | Grok 3 — reasoning + speed |
| Gladius | No | Artifact Virtual kernel |

Model selection follows — each provider shows its available models.

### 3. Channels

- **Discord** — bot token, client ID, sibling bot IDs
- **WhatsApp** — phone number, auth directory

Both are optional. Without channels, the agent works via CLI and HTTP API.

### 4. Access Control

- Owner IDs (Discord user IDs and/or WhatsApp JIDs)
- DM policy: allowlist or open
- Group policy: mention-only, allowlist, or disabled

### 5. Workspace

- Working directory path (cross-platform, forward slashes)
- API + Web UI port (default: 3006)

### 6. Review & Write

Summary of all settings, then writes files. Existing files prompt for overwrite confirmation.

## Agent Scaffold

The scaffold generates clean-room identity files — zero bleed from any existing agent. Each file is a starting template that the agent and user evolve together over time.

The `SOUL.md` template includes core operating principles:

- Be genuinely helpful, not performatively helpful
- Have opinions
- Be resourceful before asking
- Earn trust through competence

The `AGENTS.md` template includes session boot protocol, memory conventions, and safety boundaries.

## Non-Interactive Fallback

If the terminal doesn't support raw mode (e.g., piped input), the wizard falls back to numbered-list selection instead of arrow-key navigation. Works in any terminal environment.
