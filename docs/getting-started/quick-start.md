# Quick Start

Get a working agent in under 2 minutes.

## 1. Install and Initialize

```bash
npm i @symbiote-agi/symbiote
npx symbiote init
```

The [guided setup flow](wizard.md) configures the model, workspace, optional channels, identity, and network settings. Keep provider keys and channel credentials in `.env`.

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
◇ BOOT SEQUENCE
─────────────────────────────
  ● [1/4] Loading configuration ... 12ms
  ● [2/4] Validating configuration ... 3ms
  ● [3/4] Recalling operational memory (COMB) ... 45ms
  ● [4/4] Connecting channels ... 1200ms

  ⚡ READY — 1710ms
```

## 3. Talk to Your Agent

- **Discord** — mention your bot or DM it
- **WhatsApp** — send a message to the connected number
- **HTTP API** — `POST http://localhost:3006/api/v1/chat`
- **Web Control Room** — open `http://localhost:3009` in your browser
- **CLI REPL** — run `node dist/index.js` for an interactive terminal

## Manual Setup (Without Wizard)

```bash
cp symbiote.example.json symbiote.json
cp .env.example .env
```

Edit both files — set your API keys, channel tokens, workspace path, and owner IDs. See [Configuration](configuration.md) for details.

## Minimum Viable Setup (OpenRouter, no channels)

The fastest path to a running agent:

```bash
# .env
OPENROUTER_API_KEY=your_key_here
```

```json
{
  "defaultProvider": "openrouter",
  "defaultModel": "openrouter/free",
  "workspace": ".",
  "providers": { "openrouter": {} }
}
```

```bash
node dist/index.js --config=symbiote.json
```

This gives you a CLI agent with file tools, shell access, and web fetch — no Discord or WhatsApp needed. The example configuration defaults to `openrouter/free`; choose a model available to your account.

## Windows

Same commands. Symbiote is fully cross-platform:

```powershell
node dist\gateway\daemon.js --config=symbiote.json
```
