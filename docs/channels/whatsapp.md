# WhatsApp

Symbiote uses [Baileys v7](https://github.com/WhiskeySockets/Baileys) for WhatsApp Web multi-device integration.

## Setup

1. Configure in `mach6.json`:

```jsonc
{
  "whatsapp": {
    "enabled": true,
    "authDir": "~/.symbiote/whatsapp-auth",
    "phoneNumber": "your-phone-number",
    "autoRead": true,
    "policy": {
      "dmPolicy": "allowlist",
      "groupPolicy": "mention-only",
      "allowedSenders": ["your-phone@s.whatsapp.net"],
      "allowedGroups": []
    }
  }
}
```

2. Start Symbiote — a QR code will appear in the terminal
3. Scan with WhatsApp on your phone (Settings → Linked Devices)
4. Auth state persists to `authDir` — subsequent starts reconnect automatically

## Features

| Feature | Status |
|---------|--------|
| Direct messages | ✅ |
| Group messages | ✅ |
| Media (images, documents) | ✅ |
| Reactions | ✅ |
| Read receipts | ✅ |
| Typing indicators | ✅ |
| Voice notes | ✅ |
| Ephemeral messages | ✅ |

## JID Normalization

Baileys v7 uses JIDs with device suffixes: `1234567890:5@s.whatsapp.net`. Config files store them without: `1234567890@s.whatsapp.net`.

Symbiote normalizes automatically — you never need to worry about the device suffix in configuration or policy rules.

## Policies

Same policy model as Discord:

- **`dmPolicy`** — `allowlist` or `open`
- **`groupPolicy`** — `mention-only`, `open`, or `deny`
- **`allowedSenders`** — phone JIDs with DM access
- **`allowedGroups`** — group JIDs the bot responds in

## Auto-Read

When `autoRead` is `true`, Symbiote sends read receipts (blue ticks) for messages it processes. Disable for stealth operation.

## Reconnection

Baileys handles reconnection automatically. If the WebSocket drops, Symbiote detects the disconnect reason:

- **Connection lost** → automatic reconnect
- **Logged out** → re-prompts for QR scan
- **Conflict (another device)** → logs warning, attempts reconnect
