# Gemini

Google's Gemini models via the `@google/genai` SDK. Native integration — not OpenAI-compatible shim.

## Configuration

```json
{
  "providers": {
    "gemini": {}
  }
}
```

```bash
# .env
GEMINI_API_KEY=AIza...    # https://aistudio.google.com/apikey
```

## Models

| Model | Config Value | Notes |
|-------|-------------|-------|
| Gemini 2.5 Pro | `gemini-2.5-pro-preview-05-06` | Strongest reasoning, thinking support |
| Gemini 2.5 Flash | `gemini-2.5-flash-preview-04-17` | Fast + thinking support |
| Gemini 2.0 Flash | `gemini-2.0-flash` | Fast, general purpose |
| Gemini 1.5 Pro | `gemini-1.5-pro` | Long context (1M tokens) |
| Gemini 1.5 Flash | `gemini-1.5-flash` | Budget-friendly |

## Features

### Thinking Support

Gemini models with thinking enabled return `thoughtSignature` fields in their responses. Symbiote automatically preserves these signatures across tool call roundtrips — required by the Gemini API for thinking-enabled sessions.

Configure thinking depth:

```json
{
  "providers": {
    "gemini": {
      "thinkingBudget": 8192
    }
  }
}
```

### Streaming

Full streaming support via the `@google/genai` SDK. Text chunks, tool calls, and thinking tokens stream in real-time.

### Function Calling

Native function calling support. Symbiote automatically adapts tool schemas for Gemini compatibility (strips `additionalProperties` which Gemini rejects).

### System Instructions

System prompts are passed via Gemini's dedicated `systemInstruction` field — not injected into the message history. This gives the model cleaner context separation.

## Authentication

Set `GEMINI_API_KEY` in your `.env` file. Get a free key at [Google AI Studio](https://aistudio.google.com/apikey).

## Notes

- Uses the `@google/genai` SDK directly (not an OpenAI-compatible endpoint)
- `thoughtSignature` must be preserved in tool call roundtrips for thinking-enabled models — Symbiote handles this automatically
- Schema adaptation is automatic — no manual intervention needed
