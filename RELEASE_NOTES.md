# Release Notes - v5.2.0 Apex

## Symbiote v5.2.0 - Admin-Grade Tools, Hardened Agent Loop, Windows-Native Execution

**Date:** October 10, 2026

This release covers everything from v5.1 onward: the self-improving Curator, persistent memory with Memograph, native browser control, a far more resilient agent loop, a rebuilt prompt-injection guard, and full-access admin tooling that works natively on Windows, Linux and macOS.

## Highlights

- **Full-access admin agent.** The tool sandbox is off by default. `read`, `write`, `edit`, `exec` and the new `fs` and `hardware` tools reach any path and any device on the machine. Set `SYMBIOTE_SANDBOX=1` to restore owner/non-owner tiering.
- **Shell commands work on Windows.** `exec` and background processes use PowerShell (`pwsh`, then `powershell`, then `cmd`) instead of assuming `sh`. Override with `SYMBIOTE_SHELL`.
- **Long tasks no longer stall or restart from scratch.** Dropped streams are retried, hung tools time out, progress is saved every iteration, and the original task survives context compaction.
- **A prompt-injection guard that does not cry wolf.** Source code and docs no longer trigger warnings, while genuine injection in web or MCP content is flagged with obfuscation-aware detection.

## New Features

### v5.1 - Curator tool-bug detection
- Per-tool failure tracking over a sliding window of recent interactions
- Minor bugs (a single failure) produce low-confidence retry/timeout proposals
- Major bugs (repeated failures or a failure rate of 50% or more) produce high-confidence proposals to raise retries, extend timeouts or use a fallback tool, with a cooldown to avoid duplicates
- Per-tool results are now actually delivered to the Curator after each turn, and interaction success reflects real tool outcomes

### Memory and knowledge
- **Memograph integration** with the embedded vector store: snapshots are imported with SHA-256 shard-hash verification that mirrors Memograph's own hashing
- **`reseal` tool in Memograph** repairs snapshots whose hashes went stale after content edits, rewriting parent links and edges consistently
- **Skill-file ingestion** into the vector store, plus a `persona_digest` tool for consolidating user context
- **Long-term retrieval in the loop:** context dropped by truncation is preserved in the vector store and retrieved on later turns

### Channels and interfaces
- **Channel-specific response formatting** for CLI and Discord
- **Live CLI interrupts, queueing and steering** during long-running turns
- **Native browser CUA driver** (`cua_screenshot`, `cua_click`, `cua_move`, `cua_type`, `cua_press`, `cua_scroll`)
- **Refreshed CLI and TUI branding** (Symbiote name, indigo theme, minimal layout)

### Admin tools
- **`fs`**: list, stat, mkdir, move, copy, delete, chmod, symlink, and search by file name or content, across the whole machine
- **`hardware`**: CPU, memory, disks, GPU, network, USB, audio, camera, Bluetooth, displays, serial ports, battery, sensors and processes on Windows, Linux and macOS
- **`read`**: reads any path, lists directories, streams files over 10 MB, returns hex dumps for binary files and raw bytes via `encoding: base64|hex`
- **`write`**: appends, writes binary via base64, and no longer redirects paths to a temp folder
- **`exec`**: default timeout raised from 30 s to 600 s
- **`todo`** is now available in the gateway daemon

## Agent Loop Reliability

- Completion review runs only after real tool work and at most once per turn
- Mid-stream connection drops (`terminated`, `ECONNRESET`, timeouts) are retried up to three times with backoff
- A silent provider stream fails after 3 minutes and is retried (`SYMBIOTE_STREAM_IDLE_MS`)
- A hung tool is cut off after 15 minutes (`SYMBIOTE_TOOL_TIMEOUT_MS`) and the loop continues
- Progress is persisted after every iteration, so a failed turn no longer loses its tool work
- Context compaction keeps the original request and never starts on an orphaned tool result
- Per-iteration text replaces the old cumulative text, ending repeated narration in context and replies
- Empty replies after tool work are nudged instead of ending the turn silently
- Truncated tool-call JSON returns a clear error instead of running the tool with empty arguments
- Oversized tool output keeps both head and tail, because errors usually appear at the end
- A call that fails three times in a row is flagged so the model changes approach
- Provider routing, fallback chains and session path resolution were hardened for long runs

## Security

- Prompt-injection detection uses weighted, word-boundary patterns with Unicode, zero-width, bidi and look-alike normalisation, and scans embedded base64
- Output from local tools gets a single-line note for high-confidence hits; web, image, memory, MCP and unknown tools get a full untrusted-content banner
- `SYMBIOTE_INJECTION_GUARD` accepts `standard` (default), `strict` or `off`
- Bidi and invisible control characters are always stripped from tool results

## Bug Fixes

- Fixed every shell command failing on Windows because `sh` does not exist there
- Fixed an over-broad self-kill guard that blocked ordinary commands mentioning the project name
- Fixed false-positive injection warnings on most `read` and `exec` results
- Fixed turns dying on a single dropped network connection
- Fixed work being lost after a failed turn, which caused the agent to repeat earlier steps
- Fixed the agent losing its task after context compaction
- Fixed silent stops after tool-heavy runs
- Fixed SessionManager defaulting to a legacy home directory instead of the workspace sessions directory
- Fixed OpenRouter registration and authentication, plus provider fallback and routing
- Fixed Discord message drops, silent stops and timeouts
- Fixed stale to-do output in the CLI
- Fixed duplicate daemon startup, stale daemon lock detection and daemon isolation on SIGTERM
- Fixed the BLINK continuation loop and long-turn time limits
- Fixed tool-success reporting, which always read as successful
- Fixed a duplicate `bin` entry and leftover legacy names in the package manifest
- Fixed the persisted SARSI identity on existing installs, which migrates to the current name on first load

## Cleanup and Packaging

- Naming is unified on **symbiote** across code, config, environment variables (`SYMBIOTE_*`), file names and docs
- All runtime paths are project- or home-relative; hard-coded absolute and legacy paths are removed
- `.gitignore` is rebuilt to cover secrets, runtime state, sessions, vector data, `.json` and `.jsonl` user data, backups, logs and build output
- Installer scripts verify prerequisites and stop on failed steps; `install.ps1` now checks exit codes
- Clean rebuilds produce an output tree free of legacy names

## Upgrade Notes

- Rename any `MACH6_*` variables in your `.env` to `SYMBIOTE_*`
- `symbiote.json` is the only config file name; the legacy `~/.mach6` home is no longer read
- Admin access is the default. If you run Symbiote for other users, set `SYMBIOTE_SANDBOX=1`
- Run `symbiote restart` after upgrading

## Release Handoff

- **Suggested tag:** `v5.2.0`
- **Suggested release title:** `v5.2.0 Apex`
