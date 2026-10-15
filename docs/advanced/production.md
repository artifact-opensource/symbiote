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
ExecStart=/usr/bin/node dist/gateway/daemon.js --config=symbiote.json
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
        <string>--config=symbiote.json</string>
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

Build the per-machine Windows MSI from a Windows x64 machine:

```powershell
npm run build:msi
```

The MSI installs a bundled Node.js runtime and NSSM service wrapper, then configures
`SymbioteGateway` to start automatically as LocalSystem. NSSM restarts a failed gateway
after five seconds; Windows Service Control Manager recovery also restarts a failed
service wrapper. The installer keeps configuration, credentials, sessions, workspace,
and logs under `%ProgramData%\Symbiote`; uninstalling the MSI preserves that data.

To initialize the installed service from a source checkout, pass the checkout as the
seed directory when installing. The installer copies `symbiote.json` and `.env` into
the protected ProgramData directory; it does not package those files into the MSI.
Existing ProgramData configuration is preserved on upgrades.

```powershell
node .\dist\index.js stop
msiexec /i .\dist\windows-installer\Symbiote-5.3.0-x64.msi SYMBIOTE_SEED_DIRECTORY="C:\workspace\symbiote"
```

Stop an already-running gateway before installation; the service installer refuses
to proceed while another Symbiote daemon is active, avoiding a port conflict or two
competing gateway processes.

If no seed directory is supplied, the service starts with the example configuration.
Add provider keys and channel credentials to
`%ProgramData%\Symbiote\.env`, then restart the service from an elevated PowerShell:

```powershell
Restart-Service SymbioteGateway
Get-Service SymbioteGateway
Get-Content "$env:ProgramData\Symbiote\logs\gateway.stdout.log" -Tail 50
```

Build the MSI with `npm run build:msi`; it downloads pinned WiX, Node.js, and NSSM
archives and verifies each SHA-256 digest before packaging. The output is written to
`dist\windows-installer`. This deployment runs the packaged, protected application
from Program Files; use the source-checkout script below only for a trusted development
machine, because LocalSystem executes the checkout's code with full machine privileges.
To install the current checkout as a service instead, run
`scripts\windows\install-service.ps1` from an elevated PowerShell; remove only the
service while preserving its state with `scripts\windows\uninstall-service.ps1`.

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

Configure quiet hours in `symbiote.json`:

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
