# Agent Runner

The agent runner is the core loop: send context to a provider, execute any tool calls, append their results, and continue until the provider completes the turn or the runtime reaches its iteration budget. Provider streaming events are consumed by the runtime, but individual channels decide which events to display.

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
| `maxIterations` | 100 | Iteration cap per runner pass; Pulse can expand sustained work to 1,000. Blink continues across passes without a default total-depth cap. |
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

Tools run through a per-session `SandboxedToolRegistry`. The effective trust tier depends on sandbox configuration, verified channel ownership, and trusted local web requests; sub-agents inherit the parent's tier. See [Security](../advanced/security.md) before changing these settings.

## Timeouts

Foreground `exec` defaults to 5 seconds; a positive `timeout` argument (in seconds) can extend it, while background process launches are not subject to that foreground deadline. The runner applies the same deadline to the tool call. A positive `SYMBIOTE_TOOL_TIMEOUT_MS` value, in milliseconds, overrides runner-level tool deadlines.

Without that override, the runner uses the configured SARSI per-tool deadline: `read` 5 seconds, `web_fetch` 15 seconds, and memory recall/search 10 seconds. Other tools default to 15 minutes at the runner layer, though individual tools may enforce shorter network or command deadlines.

Provider requests default to 15 minutes and may be overridden by provider configuration. A silent provider stream defaults to a 3-minute idle timeout; `SYMBIOTE_STREAM_IDLE_MS` overrides it. These are per-request/stream limits, not an overall wall-clock deadline for a turn.

## Streaming

The runner exposes provider events through an `onEvent` callback:

```typescript
const result = await runAgent(messages, {
  provider,
  providerConfig,
  toolRegistry,
  onEvent: (event: StreamEvent) => {
    // 'thinking_delta' — provider is producing reasoning
    // 'text_delta'     — provider produced a partial answer
    // 'tool_start'     — tool execution beginning
    // 'tool_end'       — tool execution complete
    // 'done'           — provider stream finished
  },
});
```

These events are not all forwarded to users. The web Control Room suppresses partial answer text and displays the completed answer; reasoning and tool activity remain available there. The CLI prints the final answer after completion. Discord's progress bubble is tool-only and is finalized separately from the ordinary answer message.

## Long turns

The gateway uses Pulse to begin with the configured iteration baseline (100 by default) and expand a sustained invocation to 1,000. Blink can continue a turn across fresh runner invocations without a default total-depth limit. The runner persists conversation checkpoints as it works; an interrupted process still requires a new user-triggered run after restart. Interrupts, provider/tool failures, OS resources, and network access remain practical limits.
