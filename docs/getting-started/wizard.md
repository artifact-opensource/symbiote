# Setup Flow

Symbiote now ships with a shared setup flow used by both:

- `symbiote init` — guided CLI setup
- `symbiote init --ui` — desktop installer UI in your browser
- `symbiote install` — install, build, configure, and launch from the terminal

## What it writes

The setup flow writes:

- `mach6.json` — runtime configuration
- `.env` — secrets and host/port settings
- optional workspace identity files via `scaffoldAgent()`:
  - `SOUL.md`
  - `IDENTITY.md`
  - `USER.md`
  - `AGENTS.md`
  - `HEARTBEAT.md`

## Recommended paths

### Desktop installer

- macOS/Linux: double-click `install.command`
- Windows: double-click `install.cmd`

### Terminal setup

```bash
symbiote init
symbiote init --ui
symbiote install
```

## WhatsApp pairing

If WhatsApp is enabled, finish configuration and then run:

```bash
symbiote install
```

The CLI install flow starts the gateway in the foreground so the WhatsApp QR code is shown in the terminal.
