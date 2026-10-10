# Built-in Tools

Symbiote registers built-in tools according to enabled capabilities and channel setup. The live CLI and `/tools` command report the exact active count. Tools are sandboxed per-session via the [policy engine](policy.md).

## File System

| Tool | Description |
|------|-------------|
| `read` | Read any file on disk: text with offset/limit, directory listings, binary hex dumps, base64/hex bytes. Files over 10 MB are streamed |
| `write` | Create, overwrite or append (`append`) to files; binary via `encoding: "base64"`. Parent directories are created automatically |
| `edit` | Surgical find-and-replace editing. Matches exact text and replaces it |
| `fs` | Filesystem management: list, stat, mkdir, move, copy, delete, chmod, symlink, and search by name or content |
| `hardware` | Inspect CPU, memory, disks, GPU, network, USB, audio, camera, Bluetooth, displays, serial ports, battery, sensors and processes |

All paths accept `~` and are not restricted to the workspace.

### fs

```json
{ "action": "search", "path": "~/projects", "name": "\\.ts$", "content": "TODO" }
```

### hardware

```json
{ "kind": "gpu" }
```

Works on Windows (PowerShell/CIM), Linux and macOS. Use `exec` to change device state.

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
  "oldText": "const x = 1;",
  "newText": "const x = 2;"
}
```

`oldText` must match exactly (including whitespace). Include surrounding context for unique matches.

## Shell

| Tool | Description |
|------|-------------|
| `exec` | Execute shell commands with configurable timeout |

```json
{ "command": "npm test", "timeout": 30, "workdir": "/home/user/project" }
```

Returns stdout + stderr combined. Default timeout is 600 seconds. Commands run in PowerShell on Windows (`pwsh`, then `powershell`, then `cmd`) and `sh` elsewhere; set `SYMBIOTE_SHELL` to override. Supports `background` mode for long-running processes and `pty` for pseudo-TTY wrapping.

## Process Management

| Tool | Description |
|------|-------------|
| `process_start` | Start a background process |
| `process_poll` | Check output of a background process |
| `process_kill` | Terminate a background process |
| `process_list` | List all running background processes |

For long-running tasks (servers, watchers, builds), start them as background processes and poll for output.

## Web & Media

| Tool | Description |
|------|-------------|
| `web_fetch` | Fetch a URL and return readable content. HTML is converted to plain text |
| `image` | Analyze images with vision-capable models (local file or URL) |
| `tts` | Text-to-speech synthesis (Edge TTS, 6 voices: nova, alloy, echo, fable, onyx, shimmer) |

### web_fetch

```json
{ "url": "https://example.com", "maxChars": 50000 }
```

HTML pages are stripped to readable text/markdown. Useful for documentation lookup, API responses, and web scraping.

### image

```json
{ "image": "/path/to/screenshot.png", "prompt": "What error is shown?" }
```

Accepts local file paths or URLs. Returns the vision model's analysis.

### tts

```json
{ "text": "Hello, how can I help?", "voice": "nova", "speed": 1.0 }
```

Generates audio files from text. Returns the path to the generated audio file. Speed range: 0.25–4.0.

## Memory (VDB)

| Tool | Description |
|------|-------------|
| `memory_recall` | Search persistent memory — past conversations, decisions, context |
## Memory Compatibility Alias
| `memory_stats` | Show persistent memory database statistics |
Uses the embedded VDB and the same hybrid BM25 + sparse TF-IDF retrieval as `memory_recall`.
VDB is the embedded persistent memory engine. See [VDB documentation](../core/vdb.md) for details.

### memory_recall

```json
{ "query": "deploy key rotation", "k": 5, "source": "whatsapp" }
```

Searches across WhatsApp, Discord, webchat, and COMB entries. Filters by source optionally.

### memory_ingest

```json
{}
```

Run once to bootstrap memory from session archives. Auto-ingestion handles new sessions after that.

### memory_stats

```json
{}
```

Returns document count, term count, disk usage, last indexed timestamp, and per-source breakdown.

## Memory Search Compatibility Alias

| Tool | Description |
|------|-------------|
| `memory_search` | Compatibility alias for native `memory_recall` |

### memory_search

```json
{ "query": "authentication middleware", "mode": "hybrid", "k": 5 }
```

Uses the same embedded VDB as `memory_recall`; no external memory daemon or embedding service is required.

## Session Memory (COMB)

| Tool | Description |
|------|-------------|
| `comb_recall` | Recall persistent cross-session memory |
| `comb_stage` | Stage information for future sessions |

COMB (Cross-session Observation Memory Bank) provides lossless persistence across agent restarts. See [COMB documentation](../core/comb.md) for details.

### comb_recall

```json
{}
```

Returns staged entries from previous sessions — today's and yesterday's context.

### comb_stage

```json
{ "content": "Deploy key expires March 15, 2026. Needs rotation." }
```

Stages text for the next session. Entries accumulate daily and auto-roll into archives.

## Communication

| Tool | Description |
|------|-------------|
| `message` | Send messages, media, and reactions to any connected channel |
| `typing` | Send typing indicators |
| `presence` | Update bot presence/status |
| `delete_message` | Delete a message by ID |
| `mark_read` | Send read receipts (blue ticks on WhatsApp) |

### message

```json
{
  "channel": "discord",
  "chatId": "channel-id",
  "content": "Hello from the agent!",
  "replyToId": "message-id"
}
```

Supports text, media attachments (image, audio, video, document, voice, sticker), and reactions (`action: "react"` with `emoji` and `messageId`).

### mark_read

```json
{ "channel": "whatsapp", "chatId": "sender-jid", "messageId": "msg-id" }
```

Sends read receipts (blue ticks) on WhatsApp. Acknowledgment on Discord.

## Agent

| Tool | Description |
|------|-------------|
| `spawn` | Spawn a sub-agent for parallel task execution (max depth 3) |
| `subagent_status` | Check, list, kill, or steer spawned sub-agents |

### spawn

```json
{ "task": "Analyze all TypeScript files for security issues", "maxIterations": 25 }
```

Spawns an isolated sub-agent that runs in the background. Returns a session ID for monitoring. See [Sub-Agents](../advanced/sub-agents.md) for details.

### subagent_status

```json
{ "sessionId": "sub-abc123", "action": "status" }
```

Actions: `status` (check progress), `list` (all sub-agents), `kill` (terminate), `steer` (send guidance message).

## Web Automation

| Tool | Description |
|------|-------------|
| `web_browse` | Navigate to URL, extract page content |
| `web_click` | Click element by CSS selector or text |
| `web_type` | Type into input fields |
| `web_screenshot` | Capture page as image |
| `web_extract` | Extract content by CSS selector |
| `web_scroll` | Scroll viewport |
| `web_wait` | Wait for element or navigation |
| `web_session` | Switch browser profile |
| `web_tab_open` | Open new browser tab |
| `web_tab_switch` | Switch between tabs |
| `web_tab_close` | Close current tab |
| `web_tabs` | List all open tabs |
| `web_download` | Save downloaded file |
| `web_upload` | Upload file to input |

See [Web Automation](web-automation.md) for full documentation including profiles, encryption, and security model.

### Browser CUA

`cua_screenshot`, `cua_click`, `cua_move`, `cua_type`, `cua_press`, and `cua_scroll` provide coordinate-based computer-use controls for the active Playwright browser viewport. Capture a fresh screenshot before choosing coordinates. This driver does not control the host operating system's desktop.

Use `/tools` in the CLI or MCP `tools/list` to see the exact active registry. The set varies by runtime and configuration.
