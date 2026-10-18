# Agent Runner

The agent runner is the core loop: send context to an LLM, receive a response, execute any tool calls, repeat until the model produces a final text response or the iteration limit is reached.

## The Loop

```
1. Build context (system prompt + conversation history)
2. Send to LLM provider
3. If response contains tool calls → execute them, append results, go to 2
4. If response is text → return to user
5. If iteration limit reached → return partial result
```

Each iteration is one round-trip to the LLM. A simple question takes 1 iteration. A complex task with multiple tool calls might take 10–30.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `maxIterations` | 50 | Hard cap on tool-call loops per turn |
| `maxContextTokens` | 100,000 | Context window budget before truncation |
| `temperature` | 0.7 | Response temperature (overridable per-task with ATM) |

## Context Management

The runner monitors context size throughout the turn:

- **70% usage** — informational warning
- **80% usage** — active warning, older messages may be summarized
- **90% usage** — critical warning, aggressive truncation

Context truncation preserves the system prompt and recent messages while compressing older history. The `ContextMonitor` class tracks token estimates in real-time.

## Abort Signals

Every agent turn receives an `AbortSignal`. When an interrupt message arrives:

1. The bus fires the abort signal
2. The LLM stream is terminated
3. Any running tool execution is cancelled
4. The runner exits cleanly with a partial result

This is why "stop" works immediately — abort propagation is built into every layer.

## Tool Execution

When the LLM returns tool calls, the runner:

1. Validates the tool name against the session's policy engine
2. Executes the tool via the sandboxed tool registry
3. Sanitizes the result (prevents prompt injection from tool output)
4. Appends the result as a tool response message
5. Sends the updated context back to the LLM

Tools run in a per-session sandbox. Each session gets its own `SandboxedToolRegistry` with scoped permissions based on the policy engine.

## Streaming

The runner supports streaming via an `onEvent` callback:

```typescript
const result = await runAgent(messages, {
  provider,
  providerConfig,
  toolRegistry,
  onEvent: (event: StreamEvent) => {
    // 'text_delta' — partial text
    // 'tool_start' — tool execution beginning
    // 'tool_end'   — tool execution complete
    // 'done'       — turn finished
  },
});
```

The Web UI and HTTP API use this for real-time SSE streaming.
