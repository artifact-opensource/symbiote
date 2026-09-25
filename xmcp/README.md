# XMCP — Extended Model Context Protocol

**XMCP** is the extended MCP (Model Context Protocol) server and bridge system for the Symbiote ecosystem. It provides standardized tool and resource exposure to AI agents.

## Files

| File | Description |
|------|-------------|
| `xmcp-server.js` / `.cjs` | XMCP server — handles tool/resource registration and invocation |
| `xmcp-proxy.js` | Proxy layer — forwards MCP requests to the Mach6 gateway |
| `mcp-server.js` / `.cjs` | Core MCP server — base protocol implementation |
| `mcp-bridge.js` | Bridge — connects MCP clients to the Mach6 tool system |
| `mcp-sse-bridge.cjs` | SSE bridge — Server-Sent Events transport for MCP |
| `xmcp_api_key` | API key for XMCP authentication |
| `README-mcp-bridge.md` | Detailed MCP bridge documentation |
| `linkedin-mach6-xmcp.md` | LinkedIn article draft about XMCP |

## Architecture

```
MCP Client (AI Agent)
        │
        ▼
┌─────────────────┐
│  xmcp-proxy.js   │  ← Routes requests
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  xmcp-server.js  │  ← Tool/resource registry
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  mcp-bridge.js   │  ← Connects to Mach6 tools
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Mach6 Gateway   │  ← Port 3006
└─────────────────┘
```

## Port Allocation

| Port | Service |
|------|---------|
| 3009 | XMCP (reserved) |
| 3006 | Mach6 Gateway |

## Usage

The XMCP server is started as part of the Mach6 daemon. It does not run as a standalone service — it's embedded in the gateway process.

## API Key

The XMCP API key is stored in `xmcp_api_key`. This is used for authenticating MCP client connections.

## Future

This directory is being prepared for a new dedicated repository. The XMCP system will be extracted from the monorepo and maintained independently.
