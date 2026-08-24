# Heartbeat — Activity-Aware Scheduling

The heartbeat system fires periodic health checks and background tasks, scaling frequency based on user activity. Active users get frequent checks. Sleeping users get left alone.

## Activity States

| State | Condition | Default Interval |
|-------|-----------|-----------------|
| `active` | Last user message < 1 hour ago | 30 minutes |
| `idle` | Last user message 1-4 hours ago | 2 hours |
| `sleeping` | Last user message > 4 hours ago | 6 hours |

## Quiet Hours

Heartbeats are suppressed during quiet hours (default: 23:00–08:00 local time). The scheduler checks the current hour and skips firing if within the quiet window, even if the interval has elapsed.

Quiet hours wrap midnight correctly — `23:00–08:00` works as expected.

## Configuration

```json
{
  "heartbeat": {
    "activeIntervalMin": 30,
    "idleIntervalMin": 120,
    "sleepingIntervalMin": 360,
    "quietHoursStart": 23,
    "quietHoursEnd": 8
  }
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `activeIntervalMin` | `30` | Minutes between beats when user is active |
| `idleIntervalMin` | `120` | Minutes between beats when idle |
| `sleepingIntervalMin` | `360` | Minutes between beats when sleeping |
| `quietHoursStart` | `23` | Quiet hours start (0-23, local time) |
| `quietHoursEnd` | `8` | Quiet hours end (0-23, local time) |

## How It Works

1. The scheduler runs a check every 60 seconds
2. Each check evaluates: activity state → current interval → time since last beat → quiet hours
3. If all conditions pass, the heartbeat callback fires
4. User messages automatically reset the activity timer to `active`

## Optional Work Check

You can provide a `hasWork` callback that returns `true` only when there's actual work to do. If provided, heartbeats are suppressed when there's no pending work — even if the interval has elapsed.

## Scheduler Status

```typescript
const status = scheduler.status();
// {
//   activity: 'idle',
//   quietHours: false,
//   nextHeartbeatIn: 3600000,  // ms until next beat
//   lastUserMsg: 1709640000000
// }
```

## HEARTBEAT.md

The agent reads `HEARTBEAT.md` from its workspace during each heartbeat to determine what to check. This file is user-configurable — add system health checks, notification polling, memory maintenance tasks, or anything the agent should do periodically.

If nothing needs attention, the agent responds `HEARTBEAT_OK`.
