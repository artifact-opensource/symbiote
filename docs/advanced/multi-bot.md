# Multi-Bot Coordination

Symbiote supports running multiple bot instances in the same Discord server without echo loops or duplicate responses.

## Sibling Bot IDs

Register other bots in your `mach6.json`:

```json
{
  "discord": {
    "siblingBotIds": ["other-bot-id-1", "other-bot-id-2"]
  }
}
```

## Behaviors

### Message Filtering

Messages from sibling bots are detected and handled specially:

- **Sister messages** get injected with context: `[From your sister (BotName)]`
- The agent has **choice** — it can respond or stay silent
- A configurable cooldown prevents rapid back-and-forth

### Mention-Based Yield

When a message @mentions a specific bot:

| Scenario | This bot's behavior |
|----------|-------------------|
| @ThisBot mentioned | Responds normally |
| @SiblingBot mentioned, NOT @ThisBot | **Yields** — stays silent |
| Both mentioned | Both may respond |
| Neither mentioned | Normal policy applies |

### Cooldown

A per-channel cooldown prevents echo loops between bots:

| Setting | Default |
|---------|---------|
| Sister cooldown | 10–30 seconds |

After responding to a sister bot, the cooldown prevents another response in the same channel for the configured duration.

## Architecture Pattern

This system enables multi-agent architectures where different bots have different specializations:

```
User message → Discord
  ├── Bot A (operations, task dispatch) ← @BotA or general
  └── Bot B (creative, memory, voice) ← @BotB or general
```

Each bot sees the other's messages as sister communications and can choose to engage or yield.
