# Mach6 Symbiote 2.2 - Release Notes

## 🚀 Major Changes
- **Unified Daemon:** Introduced `unified-daemon.ts` to manage the entire runtime stack (Gateway, COMB, HEKTOR, PULSE) as a single entity.
- **Semantic Initialization:** Implemented VDB-first boot sequence. The system now ensures the Vector Database (HEKTOR) and Memory (COMB) are fully operational before the Gateway opens for requests.
- **Systemd Integration:** New `mach6-unified.service` replaces fragmented startup scripts.
- **Runtime Validation:** Added end-to-end runtime tests to verify service health during boot.

## 🛠️ Technical Improvements
- Deprecated standalone gateway startup in favor of the Unified Daemon.
- Optimized boot timings for faster recovery.
- Updated CLI setup wizard to configure the new unified service.

## 📦 Installation
1. Run `npm install` in `mach6-core`.
2. Deploy the systemd unit: `cp systemd/mach6-unified.service ~/.config/systemd/user/`.
3. Reload and start: `systemctl --user daemon-reload && systemctl --user enable --now mach6-unified`.

**Version:** 2.2.0
**Tag:** `v2.2.0-symbiote`
