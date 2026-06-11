// Symbiote — Orchestrator Boot Step
// Initializes the dual-LLM orchestrator if enabled in config
// Ported from Sirius B (Victus) — adapted for AVA's boot sequence
//
// NOTE: This file provides a standalone boot function for reference,
// but the actual initialization in AVA happens in daemon.ts after
// the tool registry is fully populated. The daemon calls
// initializeOrchestrator(this.toolRegistry) directly.

import { initializeOrchestrator, getOrchestratorProvider } from '../orchestrator/provider.js';
import { ToolRegistry } from '../tools/registry.js';
import { palette, ok, fail } from '../cli/brand.js';

/**
 * Boot the orchestrator with a given tool registry.
 * In AVA's daemon, this should be called AFTER all tools are registered
 * so that DAG node execution has access to the full toolset.
 */
export async function bootOrchestrator(toolRegistry: ToolRegistry): Promise<void> {
  try {
    const orch = await initializeOrchestrator(toolRegistry);
    if (orch) {
      console.log(ok('Orchestrator initialized (dual-LLM mode)'));
    } else {
      console.log(`${palette.dim}Orchestrator disabled${palette.reset}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(fail(`Orchestrator init failed: ${msg}`));
    // Don't throw — allow degraded mode (single LLM fallback)
  }
}
