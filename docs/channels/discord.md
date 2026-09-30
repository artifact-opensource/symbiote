# Discord

Symbiote uses [discord.js v14](https://discord.js.org/) for full-featured Discord integration.

## Setup

1. Create a Discord bot at the [Developer Portal](https://discord.com/developers/applications)
2. Enable the following intents: **Message Content**, **Guild Messages**, **Direct Messages**
3. Add your bot token and client ID to `.env`:

```bash
DISCORD_BOT_TOKEN=your-bot-token
DISCORD_CLIENT_ID=your-bot-client-id
```

4. Configure in `mach6.json`:

```jsonc
{
  "discord": {
    "enabled": true,
    "token": "${DISCORD_BOT_TOKEN}",
    "botId": "${DISCORD_CLIENT_ID}",
    "siblingBotIds": [],
    "policy": {
      "dmPolicy": "allowlist",
      "groupPolicy": "mention-only",
      "requireMention": true,
      "allowedSenders": ["your-user-id"],
      "allowedGroups": ["channel-id-1", "channel-id-2"]
    }
  }
}
```

## Features

| Feature | Status |
|---------|--------|
| Guild text channels | ✅ |
| Direct messages | ✅ |
| Threads | ✅ |
| Embeds | ✅ |
| Reactions | ✅ |
| Typing indicators | ✅ |
| File attachments | ✅ |
| Message splitting (2000 char limit) | ✅ |
| Rate limiting (token bucket) | ✅ |

## Policies

### DM Policy

- **`allowlist`** — only users in `allowedSenders` can DM the bot
- **`open`** — anyone can DM the bot

### Group Policy

- **`mention-only`** — bot only responds when @mentioned
- **`open`** — bot responds to all messages in allowed channels
- **`deny`** — bot ignores all group messages

### Sibling Bot IDs

To prevent echo loops when running multiple bots in the same server, add their IDs to `siblingBotIds`. Symbiote will ignore messages from these bots.

```json
{
  "siblingBotIds": ["other-bot-id-1", "other-bot-id-2"]
}
```

When a message @mentions a sibling bot but not this bot, Symbiote yields — it won't respond.

## Message Formatting

Symbiote automatically formats responses for Discord:

- Markdown is preserved natively
- Code blocks use Discord's syntax highlighting
- Long messages are split at natural boundaries (paragraph breaks, code block ends)
- Each split respects Discord's 2000-character limit
