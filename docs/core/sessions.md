# Sessions

Sessions are persistent conversation containers. Each session maintains its own message history, tool sandbox, and configuration overrides.

## Lifecycle

```
Create → Active → (TTL expires) → Archived
                → (Manual close) → Archived
```

Sessions are created automatically when a new conversation starts (new DM, new channel thread, new HTTP session ID). They persist to disk in the `sessionsDir` directory.

## Session Routing

The router determines which session a message belongs to:

| Channel | Session Key |
|---------|-------------|
| Discord DM | `discord:dm:{userId}` |
| Discord Channel | `discord:guild:{channelId}` |
| Discord Thread | `discord:thread:{threadId}` |
| WhatsApp DM | `whatsapp:dm:{normalizedJid}` |
| WhatsApp Group | `whatsapp:group:{groupJid}` |
| HTTP API | `http:{sessionId}` (client-specified) |

## Session Labels

Sessions can be labeled for organization:

```
/session rename "refactoring auth module"
```

Labels appear in the Web UI and `/sessions` command output.

## Per-Session Configuration

Each session inherits global settings but can override:

- **Tool permissions** — restrict or expand available tools via the policy engine
- **Iteration limits** — simple tasks get 10 iterations, complex tasks get 50
- **Complexity hints** — `simple` or `complex` affects iteration budget

## Session Manager

The `SessionManager` handles:

- Session creation and retrieval
- Message history persistence
- TTL-based expiration
- Queue management for concurrent requests
- Sub-agent session tracking

## Sub-Agent Sessions

Sessions can spawn child sessions for parallel task execution. See [Sub-Agents](../advanced/sub-agents.md) for details.

Each sub-agent gets its own session with:
- Inherited provider configuration
- Independent message history
- Sandboxed tool access
- Depth limit (max 3 levels)


## Hot Resume

Sessions survive gateway restarts via the [Hot Resume](hot-resume.md) system. Active sessions are checkpointed to disk every 60 seconds and on clean exit, then restored automatically on boot.
