import { spawn } from 'child_process';
import { createServer, Server } from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { initSarsi, shutdownSarsi } from '../sarsi/index.js';
import { startMetaLoop, stopMetaLoop } from '../meta/index.js';


/**
 * Symbiote Unified Daemon (Symbiote 3.0)
 * Manages the lifecycle of Gateway, COMB, HEKTOR, and PULSE.
 * Implements Semantic Initialization (VDB-first boot).
 * SARSI + Meta^n + Curator integrated for self-improving routing.
 */

interface ServiceConfig {
    name: string;
    command: string;
    args: string[];
    cwd?: string;
    env?: Record<string, string>;
    critical: boolean;
}

class UnifiedDaemon {
    private services: Map<string, { process: any, config: ServiceConfig }> = new Map();
    private bootSequence: string[] = ['gateway'];
    private readonly pidFile = '/tmp/symbiote-unified.pid';

    private isDaemonAlreadyRunning(): boolean {
        try {
            const raw = fs.readFileSync(this.pidFile, 'utf8').trim();
            if (!raw) return false;
            const pid = Number(raw);
            if (!Number.isInteger(pid) || pid <= 0) {
                fs.unlinkSync(this.pidFile);
                return false;
            }

            try {
                process.kill(pid, 0);
            } catch {
                try { fs.unlinkSync(this.pidFile); } catch {}
                return false;
            }

            try {
                const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
                const isUnified = cmdline.includes('unified-daemon.js') || cmdline.includes('symbiote-unified');
                const isGateway = cmdline.includes('/opt/ava/mach6/dist/gateway/daemon.js');
                if (!isUnified && !isGateway) {
                    console.warn(`[Boot] Stale PID lock detected at ${pid}; removing /tmp/symbiote-unified.pid.`);
                    try { fs.unlinkSync(this.pidFile); } catch {}
                    return false;
                }
                return true;
            } catch {
                // Some stale PIDs may be gone or inaccessible; treat them as not active.
                try { fs.unlinkSync(this.pidFile); } catch {}
                return false;
            }
        } catch {
            // no existing lock file
        }
        return false;
    }

    private isGatewayAlreadyRunning(): boolean {
        const gatewayPattern = '/opt/ava/mach6/dist/gateway/daemon.js';
        try {
            const lines = fs.readFileSync('/proc/net/tcp', 'utf8');
            if (lines.includes(': 0A0D') && lines.includes('0.0.0.0:3009')) {
                return true;
            }
        } catch {
            // fall through to process scan
        }

        try {
            const out = require('child_process').execSync('ps -eo pid,cmd --no-headers', { encoding: 'utf8' }) as string;
            return out.split('\n').some((line: string) => line.includes(gatewayPattern) && !line.includes('unified-daemon.js'));
        } catch {
            return false;
        }
    }

    private serviceDefinitions: Record<string, ServiceConfig> = {
        gateway: {
            name: 'Gateway',
            command: 'node',
            args: ['/opt/ava/mach6/dist/gateway/daemon.js', '--config=/opt/ava/mach6/symbiote.json'],
            critical: true,
        }
    };

    async boot() {
        if (this.isDaemonAlreadyRunning()) {
            console.warn('[Boot] Another Symbiote unified daemon is already running; this instance is exiting to avoid duplicate gateway startup.');
            process.exit(0);
        }

        try {
            fs.writeFileSync(this.pidFile, String(process.pid));
        } catch {
            // best effort only; do not block startup if pid file cannot be written
        }

        console.info('Symbiote 3.0: Starting Semantic Initialization sequence...');
        
        for (const serviceId of this.bootSequence) {
            const config = this.serviceDefinitions[serviceId];
            if (!config) continue;

            try {
                await this.startService(serviceId, config);
                console.info(`[Boot] ${config.name} initialized successfully.`);
            } catch (e) {
                if (config.critical) {
                    console.error(`[Boot] Critical service ${config.name} failed to start. Aborting.`);
                    process.exit(1);
                }
                console.warn(`[Boot] Non-critical service ${config.name} failed. Continuing.`);
            }
        }
        
        console.info('Symbiote 3.0: All systems operational. VDB-first boot complete.');
        
        // Initialize SARSI self-model
        try {
            initSarsi();
            console.info('[Boot] SARSI self-model initialized.');
        } catch (e) {
            console.warn('[Boot] SARSI initialization failed, continuing with defaults.', e);
        }
        
        // Start Meta^n background loop (self-improvement cycle)
        try {
            startMetaLoop();
            console.info('[Boot] Meta^n self-improvement loop started.');
        } catch (e) {
            console.warn('[Boot] Meta^n initialization failed, continuing without self-improvement.', e);
        }
    }

    private async startService(id: string, config: ServiceConfig): Promise<void> {
        if (id === 'gateway' && this.isGatewayAlreadyRunning()) {
            console.warn('[Boot] Gateway already running; skipping duplicate startup to avoid Discord shard exhaustion.');
            return;
        }

        return new Promise((resolve, reject) => {
            const child = spawn(config.command, config.args, {
                cwd: config.cwd || process.cwd(),
                env: { ...process.env, ...config.env },
                stdio: 'inherit'
            });

            child.on('error', reject);
            
            // Simple health check: wait for process to be alive
            // In a real impl, we'd check a health port or PID file
            setTimeout(() => {
                this.services.set(id, { process: child, config });
                resolve();
            }, 1000);
        });
    }

    async shutdown() {
        console.info('Shutting down Unified Daemon...');
        
        // Stop Meta^n background loop
        try { stopMetaLoop(); } catch {}
        // Flush SARSI state
        try { shutdownSarsi(); } catch {}
        
        for (const [id, service] of this.services) {
            console.info(`Stopping ${service.config.name}...`);
            service.process.kill();
        }

        try {
            if (fs.existsSync(this.pidFile)) fs.unlinkSync(this.pidFile);
        } catch {}

        process.exit(0);
    }
}

const daemon = new UnifiedDaemon();
daemon.boot();

process.on('SIGINT', () => daemon.shutdown());
process.on('SIGTERM', () => daemon.shutdown());
