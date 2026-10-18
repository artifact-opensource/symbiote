# MCP Bridge

Symbiote includes a built-in [Model Context Protocol](https://modelcontextprotocol.io/) client bridge. Connect external MCP tool servers and their tools become native Symbiote tools.

## How It Works

The MCP bridge spawns an external process (the MCP server), communicates via JSON-RPC over stdio, discovers available tools, and registers them in the tool registry.

```
Symbiote Agent → Tool Registry → MCP Bridge → (stdio) → MCP Server
```

## Configuration

```typescript
const bridge = new McpBridge({
  command: ['python3', '/path/to/mcp-server.py'],
  cwd: '/working/directory',
  env: { CUSTOM_VAR: 'value' },
  timeout: 30000,
  toolPrefix: 'ext_',
});

await bridge.connect();

// Tools are now available as ext_tool_name
for (const tool of bridge.getTools()) {
  registry.register(tool);
}
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `command` | — | Command + args to spawn the MCP server |
| `cwd` | — | Working directory for the child process |
| `env` | — | Additional environment variables |
| `timeout` | 30000 | Connection timeout in ms |
| `toolPrefix` | `""` | Prefix for registered tool names |

## Tool Prefix

Use `toolPrefix` to namespace external tools and avoid collisions with built-in tools:

```typescript
// MCP server exposes "read" tool
// With prefix "ext_", it becomes "ext_read" in Symbiote
const bridge = new McpBridge({
  command: ['node', 'my-mcp-server.js'],
  toolPrefix: 'ext_',
});
```

## Protocol

The bridge implements the MCP client protocol:

1. **Initialize** — handshake with protocol version
2. **tools/list** — discover available tools and their schemas
3. **tools/call** — execute a tool with arguments
4. **Shutdown** — clean process termination

All communication is JSON-RPC 2.0 over stdin/stdout.
