# Architecture

Symbiote is a single-process agent framework. Every component — channels, routing, sessions, tools, providers, and the web UI — runs in one Node.js daemon.

## Data Flow

```
Channels → Router → Message Bus → Agent Runner → LLM Provider
   ↑                                    ↓
   └──────────── Response ──────────────┘
```

```mermaid
graph LR
    subgraph Channels
        D[Discord]
        W[WhatsApp]
        H[HTTP API]
    end

    subgraph Router
        R[Policy · Dedup · Priority]
    end

    subgraph Bus[Message Bus]
        Q[Priority Queue · Coalescing · Interrupts · Backpressure]
    end

    subgraph Agent
        A[Runner · Tools · Abort · Iterate]
    end

    subgraph Provider
        P[LLM Provider · Hot-swappable]
    end

    UI[Web UI :3006] -->|SSE| Q

    D --> R
    W --> R
    H --> R
    R --> Q
    Q --> A
    A --> P
    P --> LLM((LLM))
```

## Layers

| Layer | Responsibility |
|-------|---------------|
| **Channels** | Platform adapters (Discord, WhatsApp, HTTP). Receive messages, send responses. Adapter pattern — adding a new platform means implementing one interface. |
| **Router** | Policy enforcement, deduplication, JID normalization, interrupt detection, priority classification. Sits between channels and the bus. |
| **Message Bus** | Priority queue with interrupt bypass, message coalescing (merges rapid-fire messages), and backpressure management. The nervous system. |
| **Agent Runner** | The agentic loop — sends context to the LLM, processes tool calls, iterates until the model produces a final response or hits the iteration limit. |
| **Providers** | LLM backends — GitHub Copilot, Anthropic, OpenAI, Gladius. Hot-swappable mid-session. All implement the same `Provider` interface. |
| **Tools** | 18 built-in tools + MCP bridge for external tool servers. Sandboxed per-session via the policy engine. |
| **Sessions** | Persistent conversation state with TTL. Sub-agent spawning up to depth 3. Each session has its own tool sandbox. |
| **Web UI** | Built-in interface at `:3006` with SSE streaming, session management, and config panel. Single HTML file, no build step. |

## Design Principles

### Single Process
No microservices. No message queues. No container orchestration. One `node` process manages everything. This eliminates an entire class of distributed systems bugs and makes deployment trivial.

### Messaging-First
Channels aren't bolted on — they're the entry point. The bus, router, and priority system exist because real-time messaging demands them. Request-response is a special case, not the default.

### Local-First
No cloud dependencies at runtime. Symbiote runs on your hardware with your keys. Provider failover means you can fall back to a local LLM (Gladius) if cloud providers are unavailable.

### Platform-Native
Each channel adapter uses the platform's native SDK (discord.js, Baileys) with full feature access. No lowest-common-denominator flattening — Discord embeds, WhatsApp reactions, and HTTP streaming all work natively.

## Project Structure

```
symbiote/
├── src/
│   ├── agent/          # Runner, context manager, system prompt builder
│   ├── boot/           # Boot sequence & validation
│   ├── channels/       # Adapter pattern — Discord, WhatsApp, router, bus
│   │   ├── bus.ts      # Priority queue, coalescing, interrupts
│   │   ├── router.ts   # Policy, dedup, JID normalization, priority
│   │   └── adapters/   # Discord (discord.js), WhatsApp (Baileys v7)
│   ├── cli/            # Interactive setup wizard, branding
│   ├── config/         # Config loader, validator, env interpolation
│   ├── cron/           # Cron budget management
│   ├── formatters/     # Platform-aware markdown formatting
│   ├── gateway/        # Persistent daemon — signals, hot-reload, turns
│   ├── heartbeat/      # Activity-aware periodic health checks
│   ├── memory/         # Index integrity checks
│   ├── providers/      # LLM providers — Copilot, Anthropic, OpenAI, Gladius
│   ├── security/       # Input sanitization
│   ├── sessions/       # Session store, queue, sub-agents
│   ├── tools/          # 18 built-in tools, policy engine, registry, MCP bridge
│   └── web/            # Web UI server (SSE streaming, static serving)
├── web/                # Web UI (single HTML file)
├── symbiote.example.json  # Example config
├── .env.example        # Example environment variables
├── symbiote.sh            # Linux/macOS start script
├── symbiote.ps1           # Windows start script
└── symbiote-gateway.service  # systemd unit file
```
