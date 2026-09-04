# Production Deployment

Symbiote is designed to run as a persistent daemon in production. One process, no containers, no orchestration.

## Linux (systemd)

Symbiote includes a systemd service file:

```bash
sudo cp symbiote-gateway.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now symbiote-gateway
```

Edit the service file to set your paths, user, and working directory:

```ini
[Unit]
Description=Symbiote AI Gateway
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/symbiote
ExecStart=/usr/bin/node dist/gateway/daemon.js --config=mach6.json
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

### Hot Reload

Apply config changes without restarting:

```bash
kill -USR1 $(pgrep -f "gateway/daemon.js")
```

### Logs

```bash
journalctl -u symbiote-gateway -f
```

## macOS (launchd)

Create `~/Library/LaunchAgents/com.symbiote.gateway.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.symbiote.gateway</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/path/to/symbiote/dist/gateway/daemon.js</string>
        <string>--config=mach6.json</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/symbiote</string>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.symbiote.gateway.plist
```

## Windows

Use [NSSM](https://nssm.cc/) to run as a Windows service:

```powershell
nssm install Symbiote "C:\Program Files\nodejs\node.exe" "dist\gateway\daemon.js --config=mach6.json"
nssm set Symbiote AppDirectory "C:\path\to\symbiote"
nssm start Symbiote
```

Alternatively, use Task Scheduler for a simpler setup.

> **Note:** `SIGUSR1` hot-reload is not available on Windows. Restart the service to apply config changes.

## Resource Requirements

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| CPU | 1 core | 2+ cores |
| RAM | 256 MB | 512 MB |
| Disk | 100 MB | 1 GB (for sessions) |
| Network | Required for cloud LLM providers | — |
| GPU | Not required | Not required |

Symbiote is CPU-only. No GPU needed. The same binary runs on a $5/month VPS or bare metal.

## Monitoring

### Health Endpoint

```bash
curl http://localhost:3006/api/v1/health
```

### Heartbeat

Symbiote includes an activity-aware heartbeat scheduler that adapts check frequency based on system load:

- **Active** — frequent checks during message processing
- **Idle** — reduced frequency when no messages are flowing
- **Sleeping** — minimal checks during quiet hours

Configure quiet hours in `mach6.json`:

```json
{
  "heartbeat": {
    "activeIntervalMin": 1,
    "idleIntervalMin": 5,
    "sleepingIntervalMin": 30,
    "quietHoursStart": 0,
    "quietHoursEnd": 6
  }
}
```

## Graceful Shutdown

Symbiote handles `SIGTERM` and `SIGINT` gracefully:

1. Stops accepting new messages
2. Completes the active agent turn (with timeout)
3. Persists all session state
4. Disconnects channels
5. Exits cleanly
