// Symbiote — Console noise filter.
// Installed first in every entry point. SYMBIOTE_LOG=debug restores all output.

const QUIET_PREFIXES = [
  '[SARSI]', '[vdb]', '[memograph]', '[skills]', '[context-store]', '[sandbox]', '[parc]',
  '[BLINK]', '[PULSE]', '[ATM]', '[runner] Iteration', '[runner] Response ready', '[runner] Stream complete',
  '[runner] Agent complete', '[gateway]', '[http]', '[turn]', '[send]', '[reaction]', '[boot]', '[meta', '[Meta',
];

const ANSI = /\x1b\[[0-9;]*m/g;

function level(): 'quiet' | 'normal' | 'debug' {
  const v = (process.env.SYMBIOTE_LOG ?? '').toLowerCase();
  return v === 'debug' || v === 'quiet' ? v : 'normal';
}

function isNoise(args: unknown[]): boolean {
  const first = args[0];
  if (typeof first !== 'string') return false;
  const text = first.replace(ANSI, '').trimStart();
  return QUIET_PREFIXES.some(prefix => text.startsWith(prefix));
}

export function installLogFilter(): void {
  if (level() === 'debug') return;
  const { log, info } = console;
  // Warnings and errors always pass; only routine info-level chatter is dropped.
  console.log = (...args: unknown[]) => { if (!isNoise(args)) log.apply(console, args as []); };
  console.info = (...args: unknown[]) => { if (!isNoise(args)) info.apply(console, args as []); };
}

installLogFilter();
