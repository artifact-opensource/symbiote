# Release Notes — Symbiote v5.3.0 Apex

**Release date:** October 12, 2026

**Upgrade:** Minor release; no configuration migration required.

Symbiote 5.3 strengthens the runtime's operational continuity and closes two user-facing reliability gaps: ambiguous shell results on Windows and Discord progress updates that exceeded Discord's message limit. It also includes the agent-loop, persistence, routing, and provider-retry improvements landed since v5.2.0.

## Highlights

- **Bounded Ops Memory.** The gateway can retain a small, expiring history of completed operational tool executions without retaining commands, arguments, output bodies, or user text.
- **Historical evidence, not stale claims.** Relevant observations are labeled as historical, include observation and expiry timestamps, and explicitly tell the agent to verify volatile state before reporting it.
- **More useful Windows shell results.** Successful commands with no output are reported as successful; path mistakes involving Windows and Git Bash receive actionable recovery guidance.
- **Discord progress messages stay valid and private.** Progress updates remain below Discord's 2,000-character limit, and previews redact common authorization headers, bearer tokens, cookies, and secret arguments.
- **One version source.** Package metadata remains the source of the version displayed by the CLI, gateway/daemon, web status, and MCP server.

## Operational Memory

Ops Memory is a separate store at `<workspace>/.symbiote/ops-memory.json`. It captures supported completed tool outcomes asynchronously after a response is delivered, so it adds no model call and does not change decisions inside the agent's tool loop.

- Stores only tool name, broad category, success/failure, coarse failure class, workspace, interaction ID, and timestamps.
- Does not store command text, tool arguments, results, conversation text, or credentials.
- Is workspace-scoped, deduplicates within an interaction, and retains at most 1,000 observations.
- Uses shorter expiry for volatile process, service, and network observations and longer expiry for stable build, repository, and memory operations.
- Adds context only when the latest user message is operationally relevant.
- Presents every observation as historical execution evidence, never proof of current state.
- Can be disabled with `SYMBIOTE_OPS_MEMORY=0`.

## Execution and Channel Reliability

- Empty stdout/stderr after a zero exit code now produces an explicit success message rather than a confusing blank result.
- Windows shell guidance explains the configured working directory, `workdir`, Git Bash drive-path syntax (`/c/...`), and why guessed Linux paths such as `/workspace` may not exist.
- Discord progress messages are capped at 1,900 characters to leave room below the API's 2,000-character content limit.
- Progress previews redact common sensitive header/value forms before they are sent to a channel.
- Focused regression tests cover empty successful commands, Windows/Git Bash path diagnostics, message-size bounds, and sensitive-value redaction.

## Agent and Memory Improvements Since v5.2.0

- Hardened tool-call/result pairing and sanitization of persisted session messages.
- Improved session persistence and recovery, Meta^n evaluation, and Curator proposal handling.
- Clarified COMB recall output as historical and instructed the agent to verify live state.
- Removed hard-coded OpenRouter daily quota and reset assumptions; retry timing follows provider response metadata.
- Added regression coverage for provider authentication errors, COMB recall, persistence, runner resilience, and adaptive improvement behavior.

## Upgrade

For a source checkout:

```bash
npm ci
npm run build
```

No `symbiote.json` migration is required. To disable Ops Memory, set `SYMBIOTE_OPS_MEMORY=0` in the gateway environment and restart the process.

On Windows, let `exec` start in the configured workspace or pass its `workdir` parameter. When explicitly using Git Bash, use `/c/...` paths rather than Windows backslashes or assumed Linux directories.

## Verification

The release build and focused tests cover shell execution, operational memory, Discord formatting/progress limits, Memograph import, session persistence, and runner behavior. Live provider and channel behavior still depends on the credentials and external services configured by each deployment.
