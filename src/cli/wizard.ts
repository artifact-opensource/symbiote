/**
 * Legacy setup entry point.
 *
 * The old multi-step wizard has been replaced by the shared guided setup flow
 * in setup.ts. This file remains as a compatibility wrapper for existing entry
 * points that still import `runWizard()`.
 */

import { runInteractiveSetup } from './setup.js';

export async function runWizard(): Promise<void> {
  await runInteractiveSetup();
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('cli/wizard.js')) {
  runWizard().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
