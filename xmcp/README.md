# xMCP — Extended Model Context Protocol

**xMCP** is the standalone HTTP service and bridge support for the Symbiote ecosystem.

## Files

| File | Description |
|------|-------------|
| `xmcp-server.js` / `.cjs` | XMCP server — handles tool/resource registration and invocation |
| `xmcp-proxy.js` | Proxy layer — forwards MCP requests to the Symbiote gateway |
| `mcp-server.js` / `.cjs` | Core MCP server — base protocol implementation |
| `mcp-bridge.js` | Bridge — connects MCP clients to the Symbiote tool system |
| `mcp-sse-bridge.cjs` | SSE bridge — Server-Sent Events transport for MCP |
| `xmcp_api_key` | API key for XMCP authentication |
| `README-mcp-bridge.md` | Detailed MCP bridge documentation |
| `linkedin-symbiote-xmcp.md` | LinkedIn article draft about XMCP |

## Architecture

```
External caller / tunnel
          │
          ▼
   xMCP HTTP server :9999
   /health, /bind, /outbound
```

The standalone server is not embedded in the Gateway and does not currently proxy requests into the React Control Room or Gateway APIs. Its implemented routes are `/health`, `/bind`, and `/outbound`; all requests require the configured bearer key.

## Port

The default xMCP port is `9999`. Set `xmcpPort` in `symbiote.json` or override it with `XMCP_PORT`. Start the service from the repository root with:

```powershell
$env:SYMBIOTE_CONFIG = "C:\path\to\symbiote.json"
node xmcp/xmcp-server.cjs
```

When running behind a tunnel or reverse proxy, route its xMCP origin to `http://127.0.0.1:9999`. Keep the API key in `.mcp/xmcp_api_key` or `XMCP_API_KEY`; do not expose the key in logs or source control.

## Usage

The current repository does not register xMCP as a Gateway-managed child process. Run or supervise it separately.

## API Key

The xMCP API key is stored in `.mcp/xmcp_api_key` by default. This is used for authenticating HTTP requests.

## Future

This directory is being prepared for a new dedicated repository. The XMCP system will be extracted from the monorepo and maintained independently.
