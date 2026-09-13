# Tool Policy Engine

The policy engine controls which tools are available to the agent in each session. It prevents unauthorized tool use and enforces resource budgets.

## Session Policies

Define per-session tool permissions:

```typescript
interface SessionPolicy {
  sessionId: string;
  tools: Record<string, 'allow' | 'deny'>;
  maxIterations?: number;
  complexity?: 'simple' | 'complex';
}
```

### Complexity Presets

| Complexity | Max Iterations | Use Case |
|-----------|----------------|----------|
| `simple` | 10 | Quick questions, lookups |
| `complex` | 50 | Multi-step tasks, code generation |

If not specified, the global `maxIterations` from `mach6.json` applies.

## Resource Budgets

Prevent runaway tool usage with daily and per-run limits:

```typescript
interface ResourceBudget {
  resource: string;
  dailyLimit: number;
  perRun?: number;
  used: number;
  resetAt: number; // ms epoch
}
```

Configure in `mach6.json`:

```json
{
  "budgets": {
    "exec": { "dailyLimit": 100, "perRun": 20 },
    "web_fetch": { "dailyLimit": 50, "perRun": 10 }
  }
}
```

When a budget is exhausted, the tool returns an error message to the agent instead of executing.

## Default Behavior

If a tool isn't explicitly listed in a session's policy, it falls through to the default: **allow**. To create a restrictive session, deny all tools and allowlist specific ones:

```typescript
const policy: SessionPolicy = {
  sessionId: 'restricted-session',
  tools: {
    'read': 'allow',
    'write': 'deny',
    'exec': 'deny',
    'web_fetch': 'allow',
  },
  complexity: 'simple',
};
```
