# Built-in Tools

Symbiote ships with 18 built-in tools available to the agent. Tools are sandboxed per-session via the [policy engine](policy.md).

## File System

| Tool | Description |
|------|-------------|
| `read` | Read file contents with optional offset/limit for large files |
| `write` | Create or overwrite files. Parent directories are created automatically |
| `edit` | Surgical find-and-replace editing. Matches exact text and replaces it |

### read

```json
{ "path": "src/index.ts", "offset": 1, "limit": 50 }
```

Returns file contents. For large files, use `offset` and `limit` to read specific line ranges.

### write

```json
{ "path": "src/new-file.ts", "content": "export const hello = 'world';" }
```

Creates parent directories if they don't exist.

### edit

```json
{
  "path": "src/index.ts",
  "old_text": "const x = 1;",
  "new_text": "const x = 2;"
}
```

`old_text` must match exactly (including whitespace). Include surrounding context for unique matches.

## Shell

| Tool | Description |
|------|-------------|
| `exec` | Execute shell commands with configurable timeout |

```json
{ "command": "npm test", "timeout": 30, "workdir": "/home/user/project" }
```

Returns stdout + stderr combined and the exit code.

## Process Management

| Tool | Description |
|------|-------------|
| `process_start` | Start a background process |
| `process_poll` | Check output of a background process |
| `process_kill` | Terminate a background process |
| `process_list` | List all running background processes |

For long-running tasks (servers, watchers, builds), start them as background processes and poll for output.

## Web

| Tool | Description |
|------|-------------|
| `web_fetch` | Fetch a URL and return readable content. HTML is converted to plain text |
| `image` | Analyze images with vision-capable models |

### web_fetch

```json
{ "url": "https://example.com", "max_chars": 50000 }
```

HTML pages are stripped to readable text/markdown. Useful for documentation lookup, API responses, and web scraping.

## Memory

| Tool | Description |
|------|-------------|
| `memory_search` | Hybrid BM25 + vector search over indexed workspace files |
| `comb_recall` | Recall persistent cross-session memory |
| `comb_stage` | Stage information for future sessions |

### memory_search

```json
{ "query": "authentication middleware", "k": 5 }
```

Searches indexed files using hybrid retrieval (keyword + semantic). Returns the most relevant file excerpts.

### comb_recall / comb_stage

COMB (Cross-session Observation Memory Bank) provides persistence across agent restarts:

- **`comb_recall`** — retrieve everything staged from previous sessions
- **`comb_stage`** — save important information for future sessions

## Communication

| Tool | Description |
|------|-------------|
| `message` | Send messages, media, and reactions to any connected channel |
| `typing` | Send typing indicators |
| `presence` | Update bot presence/status |
| `delete_message` | Delete a message by ID |
| `mark_read` | Send read receipts (WhatsApp) |

### message

```json
{
  "channel": "discord",
  "target": "channel-id",
  "text": "Hello from the agent!",
  "reply_to": "message-id"
}
```

Supports text, file attachments, embeds (Discord), and reactions.

## Media

| Tool | Description |
|------|-------------|
| `tts` | Text-to-speech synthesis via Edge TTS |

```json
{ "text": "Hello world", "voice": "en-US-AriaNeural" }
```

Generates audio files from text. Multiple voices and languages available.

## Agent

| Tool | Description |
|------|-------------|
| `spawn` | Spawn a sub-agent for parallel task execution (max depth 3) |

```json
{ "task": "Analyze all TypeScript files for security issues", "sessionId": "security-audit" }
```

See [Sub-Agents](../advanced/sub-agents.md) for details.
