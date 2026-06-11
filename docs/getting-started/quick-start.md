# Quick Start

Get a working agent in under 2 minutes.

## 1. Initialize

```bash
npx symbiote init
```

The [interactive wizard](wizard.md) walks you through 6 steps:

1. **Agent Identity** — name, emoji, personality (generates SOUL.md, IDENTITY.md, etc.)
2. **Provider** — choose from 8 LLM providers (Groq is the default — free, fastest)
3. **Channels** — Discord and/or WhatsApp (both optional)
4. **Access Control** — owner IDs, DM/group policies
5. **Workspace** — working directory and API port
6. **Review** — confirm and write files

Output:

- **`symbiote.json`** — agent configuration
- **`.env`** — secrets (API keys, bot tokens)
- **Identity files** — SOUL.md, IDENTITY.md, USER.md, AGENTS.md, HEARTBEAT.md

## 2. Start the Daemon

```bash
node dist/gateway/daemon.js --config=symbiote.json
```

You'll see the [boot sequence](../core/boot-sequence.md):

```
⚡ BOOT SEQUENCE
─────────────────────────────
  ● [1/5] Loading configuration ... 12ms
  ● [2/5] Validating configuration ... 3ms
  ● [3/5] Recalling operational memory (COMB) ... 45ms
  ● [4/5] Warming HEKTOR search index ... 450ms
  ● [5/5] Connecting channels ... 1200ms

  ⚡ READY — 1710ms
```

## 3. Talk to Your Agent

- **Discord** — mention your bot or DM it
- **WhatsApp** — send a message to the connected number
- **HTTP API** — `POST http://localhost:3006/api/v1/chat`
- **Web UI** — open `http://localhost:3006` in your browser
- **CLI REPL** — run `node dist/index.js` for an interactive terminal

## Manual Setup (Without Wizard)

```bash
cp symbiote.example.json symbiote.json
cp .env.example .env
```

Edit both files — set your API keys, channel tokens, workspace path, and owner IDs. See [Configuration](configuration.md) for details.

## Minimum Viable Setup (Groq, no channels)

The fastest path to a running agent:

```bash
# .env
GROQ_API_KEY=gsk_your_key_here
```

```json
{
  "defaultProvider": "groq",
  "defaultModel": "llama-3.3-70b-versatile",
  "workspace": ".",
  "providers": { "groq": {} }
}
```

```bash
node dist/index.js --config=symbiote.json
```

This gives you a CLI agent with file tools, shell access, and web fetch — no Discord or WhatsApp needed.

## Windows

Same commands. Symbiote is fully cross-platform:

```powershell
node dist\gateway\daemon.js --config=symbiote.json
```
