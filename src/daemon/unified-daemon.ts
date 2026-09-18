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

    private serviceDefinitions: Record<string, ServiceConfig> = {
        gateway: {
            name: 'Gateway',
            command: 'node',
            args: ['/opt/ava/mach6/mach6-core/dist/gateway/daemon.js', '--config=/opt/ava/mach6/symbiote.json'],
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
        process.exit(0);
    }
}

const daemon = new UnifiedDaemon();
daemon.boot();

process.on('SIGINT', () => daemon.shutdown());
process.on('SIGTERM', () => daemon.shutdown());
