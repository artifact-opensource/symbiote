# Setup Flow

One setup engine powers every entry point:

- `symbiote init`: guided terminal setup
- `symbiote init --ui`: the same setup in a browser installer
- `symbiote install`: install dependencies, build, run setup and launch
- `symbiote configure`: change common settings later
- `symbiote upgrade`: migrate an older `symbiote.json` to the current format

Setup is quiet by design: five short sections (Model, Workspace, Channels, Identity and an optional Network step), then a one-box summary. Piped or scripted input works too; any prompt left unanswered uses its default.

## What it writes

- `symbiote.json`: runtime configuration (config version 2, every section stubbed, paths relative to the file)
- `symbiote.schema.json`: JSON Schema referenced by `$schema`, giving editors completion and validation
- `.env`: secrets and host/port settings, grouped by section, permissions restricted where the OS supports it
- optional workspace identity files: `SOUL.md`, `IDENTITY.md`, `USER.md`, `AGENTS.md`, `HEARTBEAT.md`

Re-running setup never discards work: the previous config is saved as `symbiote.json.bak-<timestamp>`, existing sections you did not change are preserved, and secrets already in `.env` are kept.

## Upgrading an existing config

```bash
symbiote upgrade
```

The upgrade adds any missing sections, converts absolute paths inside the project to relative ones, removes duplicates, empty values and legacy keys, and moves inline API keys and tokens into `.env`, leaving `${VAR}` references behind. It never overwrites a conflicting value already in `.env`, and running it twice changes nothing.

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
