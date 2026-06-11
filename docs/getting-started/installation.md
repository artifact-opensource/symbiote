# Installation

## Requirements

- **Node.js 20+** — [Download](https://nodejs.org/)
- **npm** (ships with Node.js)
- **Git** (for cloning from source)

## From npm

```bash
npm install -g symbiote-core
```

## From Source

```bash
git clone https://github.com/Artifact-Virtual/symbiote.git
cd symbiote
npm install
npm run build
```

## Verify

```bash
npx symbiote --version
```

## What's Included

The package ships with:

- **`.env.example`** — template for all environment variables (API keys, tokens)
- **`symbiote.example.json`** — template for agent configuration
- **`symbiote-gateway.service`** — systemd unit file for Linux deployments
- **`symbiote.sh` / `symbiote.ps1`** — start scripts for Linux/macOS and Windows

Environment variables are auto-loaded from `.env` via the built-in dotenv loader — no manual `source` or `dotenv` package needed.

## Next Steps

1. Run the [setup wizard](wizard.md): `npx symbiote init`
2. Follow the [Quick Start](quick-start.md)

## Platform Support

| Platform | Status |
|----------|--------|
| Linux (x64, arm64) | ✅ Fully supported |
| macOS (Intel, Apple Silicon) | ✅ Fully supported |
| Windows (x64) | ✅ Fully supported |

Symbiote uses `os.tmpdir()` and `os.homedir()` for all path resolution — zero hardcoded Unix paths. The same codebase runs everywhere without modification.
