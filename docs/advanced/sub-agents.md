# Sub-Agents

Symbiote supports spawning sub-agents for parallel task execution. A parent agent can delegate work to child agents, each running in their own session with independent context.

## Usage

From the agent's perspective, sub-agents are spawned via the `spawn` tool:

```json
{ "task": "Audit all TypeScript files for security vulnerabilities" }
```

From the CLI:

```
/spawn Analyze the test suite and suggest improvements
```

## How It Works

1. Parent agent calls `spawn` with a task description
2. Symbiote creates a child session with:
   - Its own message history
   - Inherited provider configuration
   - Sandboxed tool access
   - A system prompt scoped to the task
3. The child agent runs independently
4. On completion, the result is injected back into the parent session
5. The parent agent continues with the sub-agent's findings

## Depth Limit

Sub-agents can spawn their own sub-agents, up to **3 levels deep**:

```
Parent (depth 0)
└── Sub-agent A (depth 1)
    └── Sub-sub-agent (depth 2)
        └── Sub-sub-sub-agent (depth 3) ← maximum
```

Attempting to spawn beyond depth 3 returns an error.

## Monitoring

### Web UI

The Web UI shows active sub-agents with:
- Task description
- Current status (running/completed/failed)
- Token usage
- Kill button

### CLI

```
/status
```

Shows active sub-agents for the current session.

## Sandboxing

Each sub-agent gets its own `SandboxedToolRegistry`:

- Tool permissions are inherited from the parent session's policy
- File system access is scoped to the workspace
- The sub-agent cannot modify the parent's session state directly

## Best Practices

- Use sub-agents for **independent, parallelizable tasks** — not sequential steps
- Keep task descriptions specific — the sub-agent has no conversation context from the parent
- Monitor depth — deeply nested sub-agents consume more resources
- Set appropriate `maxIterations` for sub-agent complexity
