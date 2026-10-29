# Heartbeat — Scoped Autonomous Work

Heartbeat schedules one-shot autonomous work only when the workspace explicitly authorizes it. The Gateway starts the scheduler, but a missing `HEARTBEAT.md`, missing `## Authorized Tasks` section, or empty section results in no provider call and no action.

```markdown
## Authorized Tasks
- [ ] Inspect the latest local backup and report whether it completed.
```

Only unchecked list items under `## Authorized Tasks` can be selected. A private, tool-free provider decision must return an exact listed task or `{"action":"idle"}`; malformed output or an invented task fails closed. The decision is not sent to channels or stored as reasoning. A selected task runs once in its own private session with trusted internal owner context, subject to `sandbox.ownerAccess`; this does not elevate the host OS account. It cannot expand scope or schedule follow-up work.

Task attempts are persisted in `.agents/heartbeat/state.json` and are not replayed after failure or Gateway restart. If `HEARTBEAT.md` changes during execution, Heartbeat pauses and requires another scope-file edit before resuming. Edit task text to authorize another attempt; use Cron for recurring tasks. Cron failures also require a deliberate manual retry because the work may have caused side effects.

Heartbeat intervals adapt to user activity (30 minutes active, 2 hours idle, 6 hours sleeping by default) and respect local quiet hours (23:00–08:00 by default). Scheduling and paths use Node.js runtime abstractions and the configured workspace; execution remains limited by host capabilities and configured sandbox policy.

See the full [Heartbeat safety and retry policy](../../core/heartbeat.md).
