# CLI Commands

## Interactive REPL

```bash
node dist/index.js --config=mach6.json
```

```
Symbiote v1.7.0 | groq/llama-3.3-70b-versatile | session: default
Tools (24): read, write, edit, exec, image, web_fetch, tts, ...
Type /help for commands

❯ _
```

## Setup Wizard

```bash
npx symbiote init
```

Guided setup flow that generates `mach6.json`, `.env`, and optional workspace identity files. Use `symbiote init` for CLI setup or `symbiote init --ui` for the desktop installer UI. See [Setup Flow](../getting-started/wizard.md).

## One-Shot Mode

```bash
node dist/index.js "Summarize the README in this directory"
```

Runs a single turn and exits. Useful for scripting and CI/CD.

## Session Commands

| Command | Description |
|---------|-------------|
| `/help` | Show all available commands |
| `/tools` | List available tools with descriptions |
| `/model <name>` | Switch model mid-session (e.g., `/model gpt-4o`) |
| `/provider <name>` | Switch provider mid-session (e.g., `/provider anthropic`) |
| `/temperature <value>` | Set temperature for next turn |
| `/spawn <task>` | Spawn a sub-agent with the given task |
| `/status` | Session stats — tokens used, tool calls, active sub-agents |
| `/sessions` | List all sessions with labels and timestamps |
| `/session rename <label>` | Rename the current session |
| `/history [N]` | Show last N messages (default: 10) |
| `/clear` | Clear current session history |
| `/quit` | Exit the REPL |

## Daemon Mode

```bash
node dist/gateway/daemon.js --config=mach6.json
```

Starts the persistent daemon with all channels (Discord, WhatsApp, HTTP API). This is the primary production mode.

### Flags

| Flag | Description |
|------|-------------|
| `--config=<path>` | Path to mach6.json (default: `./mach6.json`) |

### Signals (Linux/macOS)

| Signal | Action |
|--------|--------|
| `SIGTERM` | Graceful shutdown |
| `SIGINT` | Graceful shutdown (Ctrl+C) |
| `SIGUSR1` | Hot-reload configuration |
