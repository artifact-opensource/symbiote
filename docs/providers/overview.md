# Provider Abstraction Specification

## Goal
Introduce a provider-agnostic interface for model backends so the engine can support OpenAI-compatible, Anthropic-compatible, and Qwen-compatible providers behind one internal contract.

## Principles
- The core engine speaks one normalized provider protocol.
- Provider adapters translate between backend-specific API shapes and the normalized protocol.
- Provider-specific quirks stay inside adapters.
- Configuration is explicit, composable, and safe to validate at boot.

## Normalized Concepts
### Message
A chat message has:
- `role`: `system | user | assistant | tool`
- `content`: string or rich content blocks
- optional `name`
- optional `tool_call_id`
- optional `tool_calls`

### ContentBlock
A message may contain structured blocks:
- `text`
- `image`
- `tool_use`
- `tool_result`

### ToolCall
A tool call has:
- `id`
- `name`
- `input`
- optional `extra` metadata for provider-specific passthrough fields

### ToolDef
Tool definitions use JSON Schema and include:
- `name`
- `description`
- `parameters`

### Usage
Normalized usage reports:
- `inputTokens`
- `outputTokens`
- optional cache read/write tokens

### StreamEvent
Streaming output is represented as:
- `text_delta`
- `tool_use_start`
- `tool_use_delta`
- `tool_use_end`
- `thinking_delta`
- `usage`
- `done`

## ProviderConfig
A provider accepts:
- `apiKey?`
- `baseUrl?`
- `model`
- `maxTokens?`
- `temperature?`
- `timeoutMs?`
- `systemPrompt?`

Providers may also accept extra transport fields, but those stay adapter-specific.

## Provider Interface
Every provider must expose:
- `name: string`
- `stream(messages, tools, config): AsyncIterable<StreamEvent>`

This is the only interface the engine should depend on.

## Adapter Responsibilities
### OpenAI-compatible adapter
Use for OpenAI, Groq, xAI, Ollama-backed OpenAI endpoints, OpenRouter, and other compatible endpoints.
- Convert messages to `chat/completions` format
- Convert tools to OpenAI function tools
- Normalize SSE deltas into the unified stream events
- Preserve provider-specific metadata where possible

### Anthropic-compatible adapter
Use for Anthropic and Anthropic-like endpoints.
- Convert messages to Anthropic message blocks
- Convert tool calls to `tool_use` / `tool_result`
- Translate SSE event types to the unified stream events

### Qwen-compatible adapter
Use for Qwen-style APIs or models that need prompt-style conversion.
- Convert messages to a prompt or alternate request body as required
- Support a text-first fallback when structured tool streaming is unavailable
- Still emit normalized `text_delta` and `done` events

## Compatibility Policy
- Prefer provider compatibility over provider brand names.
- Treat OpenRouter as a configuration preset over an API family.
- Treat free-ai as a provider only if it exposes a stable contract; otherwise map it onto an existing compatibility adapter.
- All providers should validate configuration at boot.

## Error Handling
- Normalize transport failures into descriptive errors.
- Retry 429/rate-limited OpenAI-compatible requests with provider delay hints when available.
- Fail fast on invalid provider configuration.
- Skip orphaned tool results rather than corrupting a stream.

## Boot Validation
Boot should confirm:
- provider presence
- required auth fields
- endpoint reachability where appropriate
- model string validity when the provider requires it

Boot failures should not crash unrelated providers.

## Extensibility
To add a new provider:
1. implement the provider adapter
2. register it in the provider map
3. document its config in `docs/providers/`
4. add a minimal integration test or smoke test

## Non-goals
- No provider-specific logic in the orchestration core
- No duplicated message model per backend
- No runtime guessing of provider semantics

## Acceptance Criteria
- The codebase has a single provider contract
- OpenAI-compatible providers share one adapter path
- Anthropic-compatible providers share one adapter path
- Qwen-compatible support exists as a first-class adapter or fallback
- Documentation explains the abstraction clearly
- The project builds successfully after integration
