import { spawn } from 'child_process';
import * as path from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// This file lives at dist/daemon/unified-daemon.js — the gateway sits at dist/gateway/daemon.js
const DIST_ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(DIST_ROOT, '..');

/**
 * Symbiote Unified Daemon (Symbiote 3.0)
 * Process supervisor — spawns the gateway as a subprocess and restarts it on crash.
 * The gateway itself boots SARSI + the Meta^n self-improvement loop directly
 * (see gateway/daemon.ts) — this supervisor does not duplicate that.
 *
 * Optional — most deployments run the gateway directly (`symbiote start` /
 * `node dist/gateway/daemon.js`). Use this only if you want OS-level process
 * supervision without systemd/pm2.
 */

interface ServiceConfig {
    name: string;
    command: string;
    args: string[];
    cwd?: string;
    env?: Record<string, string>;
    critical: boolean;
}

function resolveConfigArg(): string {
    const fromArgv = process.argv.find(a => a.startsWith('--config='))?.split('=')[1];
    if (fromArgv) return fromArgv;
    const candidates = ['symbiote.json', 'mach6.json'].map(f => path.join(PROJECT_ROOT, f));
    return candidates.find(p => existsSync(p)) ?? candidates[0];
}

class UnifiedDaemon {
    private services: Map<string, { process: any, config: ServiceConfig }> = new Map();
    private bootSequence: string[] = ['gateway'];

    private serviceDefinitions: Record<string, ServiceConfig> = {
        gateway: {
            name: 'Gateway',
            command: 'node',
            args: [path.join(DIST_ROOT, 'gateway', 'daemon.js'), `--config=${resolveConfigArg()}`],
            cwd: PROJECT_ROOT,
            critical: true,
        }
    };

    async boot() {
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
    }

    private async startService(id: string, config: ServiceConfig): Promise<void> {
        return new Promise((resolve, reject) => {
            const child = spawn(config.command, config.args, {
                cwd: config.cwd || process.cwd(),
                env: { ...process.env, ...config.env },
                stdio: 'inherit'
            });

            child.on('error', reject);

            // Restart on unexpected exit (crash resilience)
            child.on('exit', (code: number | null, signal: string | null) => {
                if (this.shuttingDown) return;
                console.warn(`[supervisor] ${config.name} exited (code=${code}, signal=${signal}) — restarting in 2s...`);
                setTimeout(() => {
                    this.startService(id, config).catch(err => {
                        console.error(`[supervisor] Failed to restart ${config.name}:`, err);
                    });
                }, 2000);
            });
            
            // Simple health check: wait for process to be alive
            // In a real impl, we'd check a health port or PID file
            setTimeout(() => {
                this.services.set(id, { process: child, config });
                resolve();
            }, 1000);
        });
    }

    private shuttingDown = false;

    async shutdown() {
        this.shuttingDown = true;
        console.info('Shutting down Unified Daemon...');
        
        for (const [, service] of this.services) {
            console.info(`Stopping ${service.config.name}...`);
            service.process.kill();
        }
        process.exit(0);
    }
}

const daemon = new UnifiedDaemon();
daemon.boot();

process.on('SIGINT', () => daemon.shutdown());
process.on('SIGTERM', () => daemon.shutdown());
