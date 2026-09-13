// Symbiote — Clean Boot Sequence (fixes Pain #20)
// Single entry point. Each step has timeout + fallback. Never crash on partial failure.
// 
// Built by Artifact Virtual.

import { palette, gradient, multiGradient, ok, warn, fail, divider } from '../cli/brand.js';

export type BootStepStatus = 'pending' | 'running' | 'ok' | 'degraded' | 'failed';

export interface BootStep {
  name: string;
  description: string;
  timeoutMs: number;
  required: boolean; // if false, failure = degraded, not fatal
  execute: () => Promise<void>;
}

export interface BootResult {
  step: string;
  status: BootStepStatus;
  durationMs: number;
  error?: string;
}

// ── Step Icons ──────────────────────────────────────────────────

const STEP_ICONS: Record<string, string> = {
  'config-load':     '◈',
  'config-validate': '◈',
  'comb-recall':     '◎',
  'hektor-warm':     '◉',
  'channel-connect': '◇',
};

function stepIcon(name: string): string {
  return STEP_ICONS[name] ?? '›';
}

/**
 * Run the boot sequence. Each step runs in order with timeout.
 * Non-required steps degrade gracefully instead of crashing.
 */
export async function runBootSequence(steps: BootStep[]): Promise<{
  results: BootResult[];
  ready: boolean;
  degraded: string[];
}> {
  const results: BootResult[] = [];
  const degraded: string[] = [];
  let fatal = false;

  const title = gradient('BOOT SEQUENCE', [138, 43, 226], [0, 229, 255]);
  console.log(`\n  ${palette.bold}${title}${palette.reset}`);
  console.log(divider());
  console.log();

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    if (fatal) {
      results.push({ step: step.name, status: 'pending', durationMs: 0, error: 'Skipped (prior fatal error)' });
      console.log(`  ${palette.dim}  ○ ${step.name}: skipped${palette.reset}`);
      continue;
    }

    const start = Date.now();
    const icon = stepIcon(step.name);
    const stepNum = `${palette.dim}[${i + 1}/${steps.length}]${palette.reset}`;
    const spinner = `${palette.violet}${icon}${palette.reset}`;
    process.stdout.write(`  ${spinner} ${stepNum} ${palette.white}${step.description}${palette.reset}${palette.dim}...${palette.reset}`);

    try {
      await Promise.race([
        step.execute(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Timeout after ${step.timeoutMs}ms`)), step.timeoutMs)
        ),
      ]);

      const duration = Date.now() - start;
      results.push({ step: step.name, status: 'ok', durationMs: duration });
      // Clear the line and rewrite with success
      process.stdout.write(`\r\x1b[2K`);
      console.log(`  ${palette.green}●${palette.reset} ${stepNum} ${palette.white}${step.description}${palette.reset} ${palette.dim}${duration}ms${palette.reset}`);

    } catch (err) {
      const duration = Date.now() - start;
      const errMsg = err instanceof Error ? err.message : String(err);
      process.stdout.write(`\r\x1b[2K`);

      if (step.required) {
        results.push({ step: step.name, status: 'failed', durationMs: duration, error: errMsg });
        console.log(`  ${palette.red}✗${palette.reset} ${stepNum} ${palette.white}${step.description}${palette.reset} ${palette.red}FATAL${palette.reset}`);
        console.log(`    ${palette.dim}${errMsg}${palette.reset}`);
        fatal = true;
      } else {
        results.push({ step: step.name, status: 'degraded', durationMs: duration, error: errMsg });
        degraded.push(step.name);
        console.log(`  ${palette.yellow}◐${palette.reset} ${stepNum} ${palette.white}${step.description}${palette.reset} ${palette.yellow}degraded${palette.reset}`);
        console.log(`    ${palette.dim}${errMsg}${palette.reset}`);
      }
    }
  }

  const ready = !fatal;
  const totalMs = results.reduce((s, r) => s + r.durationMs, 0);

  console.log();
  console.log(divider());

  if (ready) {
    if (degraded.length > 0) {
      const status = gradient('READY', [255, 234, 0], [255, 160, 0]);
      console.log(`  ${palette.bold}${palette.yellow}◐${palette.reset} ${palette.bold}${status}${palette.reset} ${palette.dim}(degraded: ${degraded.join(', ')}) — ${totalMs}ms${palette.reset}`);
    } else {
      const status = gradient('READY', [0, 230, 118], [0, 188, 212]);
      console.log(`  ${palette.bold}${palette.green}⚡${palette.reset} ${palette.bold}${status}${palette.reset} ${palette.dim}— ${totalMs}ms${palette.reset}`);
    }
  } else {
    const status = gradient('BOOT FAILED', [255, 82, 82], [255, 145, 0]);
    console.log(`  ${palette.bold}${palette.red}✗${palette.reset} ${palette.bold}${status}${palette.reset}`);
  }
  console.log();

  return { results, ready, degraded };
}

/**
 * Create standard boot steps for Symbiote.
 */
export function createDefaultBootSteps(hooks: {
  loadConfig: () => Promise<void>;
  validateConfig: () => Promise<void>;
  combRecall: () => Promise<void>;
  hektorWarm: () => Promise<void>;
  channelConnect: () => Promise<void>;
}): BootStep[] {
  return [
    { name: 'config-load', description: 'Loading configuration', timeoutMs: 5_000, required: true, execute: hooks.loadConfig },
    { name: 'config-validate', description: 'Validating configuration', timeoutMs: 5_000, required: true, execute: hooks.validateConfig },
    { name: 'comb-recall', description: 'Recalling operational memory (COMB)', timeoutMs: 15_000, required: false, execute: hooks.combRecall },
    { name: 'hektor-warm', description: 'Warming HEKTOR search index', timeoutMs: 60_000, required: false, execute: hooks.hektorWarm },
    { name: 'channel-connect', description: 'Connecting channels', timeoutMs: 30_000, required: false, execute: hooks.channelConnect },
  ];
}
