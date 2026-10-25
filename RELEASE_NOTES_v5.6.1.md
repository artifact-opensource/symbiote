# Symbiote v5.6.1 — Apex

**Released October 25, 2026**

This patch release focuses on reliable agent turns, session persistence, and runtime process handling.

## Fixed

- **Removed duplicate internal review turns from saved conversations.** Completion review no longer runs for read-only tool calls. When review is needed after a mutating tool, its internal prompt and draft answer remain available to the model but are excluded from saved checkpoints and returned conversation history. The final answer remains the user-facing response.
- **Prevented concurrent session saves from colliding on a shared temporary file.** Each write now stages to its own temporary path. Rename retries are limited to contention errors, and failures are reported with session context while Discord receives a safe, actionable storage warning.
- **Stopped expected closed-pipe errors from polluting health telemetry.** Once stdout or stderr is closed by its reader, the gateway stops writing to that stream rather than repeatedly recording the same EPIPE condition.
- **Made shell startup failures easier to diagnose.** Foreground and background shell tools validate working directories and shell executables before spawn, then report clear errors if the process still cannot start.
- **Prevented duplicate OpenRouter stream completion events.** Repeated finish chunks can no longer emit repeated end-of-turn signals. A streamed response returned with HTTP 202 is consumed normally; a JSON asynchronous acknowledgement is reported explicitly because the documented chat-completions API does not define a completion-polling contract.

## Changed

- SARSI provider routing now honors the configured default provider/model and only uses explicitly configured fallbacks. Newly created SARSI rules use `openrouter/free`.
- Provider retry behavior was hardened.
- Added regression tests for runner history, rate-limit handling, OpenRouter completion events, provider routing, session writes, and shell/process failures.

## Validation

- The focused regression suite passed: 55 tests.
- The compiled release suite passed: 197 tests.
- `npx tsc --noEmit` and `npm run build` passed.
- A live authenticated request through `openrouter/free` returned HTTP 200 and the expected streamed answer.

## Upgrade notes

- No configuration migration is required.
- From a source checkout, run `npm ci` and `npm run build`.
- Download the Windows installer or Linux npm tarball from the GitHub Release assets. The website’s platform download buttons resolve the assets from the latest published release.
- The `@artifact-opensource/symbiote` package is also published to GitHub Packages.
