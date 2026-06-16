# Port Allocation

| Port | Service | Status | Description |
|------|---------|--------|-------------|
| `3010` | Symbiote Dashboard | **Active** | React webapp — telemetry, chat, image gen, plugins |
| `3009` | XMCP | **Reserved** | Extended Model Context Protocol server |
| `3006` | Mach6 Gateway | **Active** | Main agent gateway — chat, tools, sessions |

## Deprecated

| Port | Service | Status |
|------|---------|--------|
| `3006` (old) | Legacy Web UI chat | **Deprecated** — merged into gateway |

## Notes

- The old web UI chat (previously on port 3006 via `src/web/server.ts`) has been deprecated
- Port 3009 is reserved for the upcoming XMCP standalone server
- The Symbiote Dashboard (port 3010) is the primary web interface
