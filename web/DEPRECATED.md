# ⚠️ DEPRECATED

This web UI has been replaced by the new Symbiote Dashboard.

## Migration

| Old | New |
|-----|-----|
| `web/` static files | `webapp/` — full React dashboard |
| Port 3006 (shared with gateway) | Port 3010 (dedicated) |
| Basic HTML/JS | React + TypeScript + Vite |
| No telemetry | Live system telemetry |
| No image gen | Pollinations.ai + Gemini |
| No plugins | Full plugin system |

## New Dashboard

The new dashboard is in the `webapp/` directory. To run:

```bash
cd webapp
npm install
npm run build
NODE_ENV=production node dist/server.cjs
```

Access at: http://localhost:3010

## Port Allocation

| Port | Service | Status |
|------|---------|--------|
| 3010 | Symbiote Dashboard (webapp) | **Active** |
| 3009 | Reserved for xmcp | Reserved |
| 3006 | Mach6 Gateway | Active |
