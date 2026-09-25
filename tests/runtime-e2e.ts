import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from './utils/logger';

/**
 * Symbiote 3.0 Runtime Tests
 * Verifies the Unified Daemon and VDB-first boot sequence.
 */

async function runTests() {
    logger.info('Running Symbiote 3.0 Runtime Tests...');

    const tests = [
        {
            name: 'Unified Daemon Process Check',
            fn: () => {
                const ps = execSync('pgrep -f unified-daemon.js').toString();
                return ps.length > 0;
            }
        },
        {
            name: 'HEKTOR VDB Availability',
            fn: () => {
                const health = execSync('curl -s http://127.0.0.1:8000/health').toString();
                return health.includes('ok');
            }
        },
        {
            name: 'COMB Persistence Check',
            fn: () => {
                const health = execSync('curl -s http://127.0.0.1:9001/health').toString();
                return health.includes('ok');
            }
        },
        {
            name: 'Gateway Connectivity',
            fn: () => {
                const health = execSync('curl -s http://127.0.0.1:9002/health').toString();
                return health.includes('ok');
            }
        }
    ];

    let passed = 0;
    for (const test of tests) {
        try {
            if (await test.fn()) {
                logger.info(`✅ ${test.name} passed.`);
                passed++;
            } else {
                logger.error(`❌ ${test.name} failed.`);
            }
        } catch (e) {
            logger.error(`❌ ${test.name} errored: ${e.message}`);
        }
    }

    logger.info(`Test Summary: ${passed}/${tests.length} passed.`);
    if (passed !== tests.length) process.exit(1);
}

runTests();
