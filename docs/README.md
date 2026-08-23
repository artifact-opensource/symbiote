# Symbiote

**Autonomous AI agent gateway with web automation. Single process. Any machine.**

Symbiote is a self-contained AI agent gateway that handles multi-channel communication, persistent memory, web browsing, and tool execution from a single TypeScript process.

## Key Capabilities

- **31 tools** including 14 web automation tools
- **Multi-channel**: Discord, WhatsApp, webchat, HTTP API
- **Web automation**: Playwright-powered browsing with encrypted profiles
- **Persistent memory**: VDB engine with BM25 + TF-IDF hybrid search
- **Provider chain**: Multiple LLM providers with circuit-breaker failover
- **Zero external deps**: No Docker, no Redis, no database server

## Documentation

- [Quick Start](getting-started/quick-start.md) — up and running in 5 minutes
- [Installation](getting-started/installation.md) — detailed setup guide
- [Configuration](core/configuration.md) — all config options
- [Tools Reference](tools/README.md) — all 31 tools documented
- [Web Automation](tools/web-automation.md) — browsing suite deep dive
- [Channels](channels/README.md) — Discord, WhatsApp, webchat, HTTP
- [Architecture](advanced/architecture.md) — system design
- [Providers](providers/README.md) — LLM provider configuration

Built by [Artifact Virtual](https://artifactvirtual.com). v3.0.0.
