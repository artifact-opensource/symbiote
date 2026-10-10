/**
 * Symbiote — Brand Kit
 * Visual identity for CLI surfaces. Colors, logos, formatting.
 * 
 * Built by Artifact Virtual.
 */

import { RELEASE_CODENAME } from '../meta/version.js';

// ── ANSI 256-Color + True Color Helpers ─────────────────────────

// True color: \x1b[38;2;r;g;bm (foreground)
const colorEnabled = process.env.NO_COLOR === undefined
  && process.env.FORCE_COLOR !== '0'
  && (process.env.FORCE_COLOR !== undefined || (process.stdout.isTTY === true && process.env.TERM !== 'dumb'));
const rgb = (r: number, g: number, b: number) => colorEnabled ? `\x1b[38;2;${r};${g};${b}m` : '';
const bgRgb = (r: number, g: number, b: number) => colorEnabled ? `\x1b[48;2;${r};${g};${b}m` : '';

// ── Brand Palette ───────────────────────────────────────────────

export const palette = {
  // Primary — restrained indigo
  violet:      rgb(119, 129, 205),
  purple:      rgb(82, 91, 164),
  deepPurple:  rgb(48, 55, 112),

  // Accent — restrained amber
  gold:        rgb(255, 190, 112),
  amber:       rgb(239, 145, 89),
  warmGold:    rgb(201, 142, 86),

  // Energy — clear sky blue
  cyan:        rgb(105, 190, 231),
  teal:        rgb(70, 160, 184),
  ice:         rgb(186, 224, 232),

  // Neutrals
  white:       rgb(240, 240, 245),
  silver:      rgb(158, 158, 168),
  dim:         rgb(100, 100, 115),
  dark:        rgb(60, 60, 75),

  // Status
  green:       rgb(0, 230, 118),
  red:         rgb(255, 82, 82),
  yellow:      rgb(255, 234, 0),
  orange:      rgb(255, 145, 0),

  // Reset
  reset:       colorEnabled ? '\x1b[0m' : '',
  bold:        colorEnabled ? '\x1b[1m' : '',
  dim_attr:    colorEnabled ? '\x1b[2m' : '',
  italic:      colorEnabled ? '\x1b[3m' : '',
  underline:   colorEnabled ? '\x1b[4m' : '',
};

// ── Gradient Text ───────────────────────────────────────────────

/**
 * Apply a horizontal gradient across text (character-by-character).
 * Interpolates between start and end RGB colors.
 */
export function gradient(text: string, from: [number, number, number], to: [number, number, number]): string {
  if (text.length === 0) return '';
  const chars = [...text];
  return chars.map((ch, i) => {
    const t = chars.length > 1 ? i / (chars.length - 1) : 0;
    const r = Math.round(from[0] + (to[0] - from[0]) * t);
    const g = Math.round(from[1] + (to[1] - from[1]) * t);
    const b = Math.round(from[2] + (to[2] - from[2]) * t);
    return `${rgb(r, g, b)}${ch}`;
  }).join('') + palette.reset;
}

/**
 * Multi-stop gradient across text.
 */
export function multiGradient(text: string, stops: [number, number, number][]): string {
  if (text.length === 0 || stops.length === 0) return '';
  if (stops.length === 1) return gradient(text, stops[0], stops[0]);

  const chars = [...text];
  const segmentLen = chars.length / (stops.length - 1);

  return chars.map((ch, i) => {
    const segIndex = Math.min(Math.floor(i / segmentLen), stops.length - 2);
    const t = (i - segIndex * segmentLen) / segmentLen;
    const from = stops[segIndex];
    const to = stops[segIndex + 1];
    const r = Math.round(from[0] + (to[0] - from[0]) * t);
    const g = Math.round(from[1] + (to[1] - from[1]) * t);
    const b = Math.round(from[2] + (to[2] - from[2]) * t);
    return `${rgb(r, g, b)}${ch}`;
  }).join('') + palette.reset;
}

// ── ASCII Art ───────────────────────────────────────────────────

/** Brand gradient: indigo → violet → cyan. */
export const BRAND_STOPS: [number, number, number][] = [[99, 102, 241], [168, 85, 247], [34, 211, 238]];

const WORDMARK = [
  '╔═╗╦ ╦╔╦╗╔╗ ╦╔═╗╔╦╗╔═╗',
  '╚═╗╚╦╝║║║╠╩╗║║ ║ ║ ║╣ ',
  '╚═╝ ╩ ╩ ╩╚═╝╩╚═╝ ╩ ╚═╝',
];

/** Per-character gradient shifted by row so the wordmark shimmers diagonally. */
function shimmer(line: string, row: number, rows: number, width: number): string {
  const chars = [...line];
  return chars.map((ch, i) => {
    if (ch === ' ') return ch;
    const t = Math.min(1, (i + row * 3) / (width + (rows - 1) * 3));
    const seg = t < 0.5 ? 0 : 1;
    const local = seg === 0 ? t * 2 : (t - 0.5) * 2;
    const a = BRAND_STOPS[seg];
    const b = BRAND_STOPS[seg + 1];
    return `${rgb(Math.round(a[0] + (b[0] - a[0]) * local), Math.round(a[1] + (b[1] - a[1]) * local), Math.round(a[2] + (b[2] - a[2]) * local))}${ch}`;
  }).join('') + palette.reset;
}

/** Gradient wordmark for startup and help surfaces. */
export function banner(): string {
  const width = Math.max(...WORDMARK.map(l => [...l].length));
  return WORDMARK.map((line, row) => `  ${palette.bold}${shimmer(line, row, WORDMARK.length, width)}`).join('\n');
}

/**
 * Compact one-line logo for prompts and headers.
 */
export function logo(): string {
  return `${palette.bold}${multiGradient('◈ Symbiote', BRAND_STOPS)}${palette.reset}`;
}

/** Gradient section title with a hairline rule: "◈ STATUS ─────". */
export function heading(title: string): string {
  const text = title.toUpperCase();
  const rule = palette.dark + '─'.repeat(Math.max(4, 44 - text.length)) + palette.reset;
  return `  ${palette.violet}◈${palette.reset} ${palette.bold}${multiGradient(text, BRAND_STOPS)}${palette.reset} ${rule}`;
}

/** Dim hint line. */
export function hint(text: string): string {
  return `  ${palette.dim}${text}${palette.reset}`;
}

/** Inline command reference, e.g. `symbiote start`. */
export function cmd(text: string): string {
  return `${palette.cyan}${text}${palette.reset}`;
}

export function createActivityIndicator() {
  const enabled = process.stdout.isTTY === true && process.env.TERM !== 'dumb';
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let frame = 0;
  let label = 'thinking';
  let timer: ReturnType<typeof setInterval> | undefined;

  const render = () => {
    if (!enabled) return;
    const shortLabel = label.length > 20 ? `${label.slice(0, 19)}…` : label;
    process.stdout.write(`\r  ${palette.violet}${frames[frame++ % frames.length]}${palette.reset} ${palette.dim}${shortLabel}${palette.reset}`);
  };

  return {
    start(nextLabel = label) {
      label = nextLabel;
      if (!enabled || timer) return;
      render();
      timer = setInterval(render, 110);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      if (enabled) process.stdout.write('\r\x1b[2K');
    },
  };
}

// ── Box Drawing ─────────────────────────────────────────────────

/**
 * Draw a bordered box around text lines.
 */
export function box(lines: string[], opts?: {
  borderColor?: string;
  padding?: number;
  width?: number;
  title?: string;
}): string {
  const borderColor = opts?.borderColor ?? palette.violet;
  const padding = opts?.padding ?? 1;
  const pad = ' '.repeat(padding);

  // Calculate width from content (strip ANSI for measurement)
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const contentWidths = lines.map(l => stripAnsi(l).length);
  const titleWidth = opts?.title ? stripAnsi(opts.title).length + 4 : 0;
  const innerWidth = opts?.width ?? Math.max(...contentWidths, titleWidth) + padding * 2;

  const top = opts?.title
    ? `${borderColor}╭─ ${palette.reset}${opts.title}${borderColor} ${'─'.repeat(Math.max(0, innerWidth - stripAnsi(opts.title).length - 1))}╮${palette.reset}`
    : `${borderColor}╭${'─'.repeat(innerWidth + 2)}╮${palette.reset}`;
  const bottom = `${borderColor}╰${'─'.repeat(innerWidth + 2)}╯${palette.reset}`;

  const padded = lines.map(line => {
    const visible = stripAnsi(line).length;
    const rightPad = Math.max(0, innerWidth - visible);
    return `${borderColor}│${palette.reset} ${line}${' '.repeat(rightPad)} ${borderColor}│${palette.reset}`;
  });

  return [top, ...padded, bottom].join('\n');
}

// ── Section Headers ─────────────────────────────────────────────

export function sectionHeader(title: string): string {
  return `\n${heading(title)}\n`;
}

export function subHeader(text: string): string {
  return `  ${palette.dim_attr}${palette.silver}${text}${palette.reset}`;
}

// ── Status Indicators ───────────────────────────────────────────

export function ok(msg: string): string {
  return `  ${palette.green}✓${palette.reset} ${msg}`;
}

export function warn(msg: string): string {
  return `  ${palette.yellow}⚠${palette.reset} ${msg}`;
}

export function fail(msg: string): string {
  return `  ${palette.red}✗${palette.reset} ${msg}`;
}

export function info(msg: string): string {
  return `  ${palette.cyan}›${palette.reset} ${msg}`;
}

export function step(label: string, detail: string): string {
  return `  ${palette.violet}${label}${palette.reset} ${detail}`;
}

// ── Progress Bar ────────────────────────────────────────────────

export function progressBar(current: number, total: number, width = 30): string {
  const ratio = Math.min(1, current / total);
  const filled = Math.round(width * ratio);
  const empty = width - filled;

  const bar = gradient('█'.repeat(filled), BRAND_STOPS[0], BRAND_STOPS[2])
    + palette.dark + '░'.repeat(empty) + palette.reset;

  return `  ${bar} ${palette.silver}${current}/${total}${palette.reset}`;
}

// ── Key-Value Display ───────────────────────────────────────────

export function kv(key: string, value: string, keyWidth = 14): string {
  return `${palette.silver}${key.padEnd(keyWidth)}${palette.reset} ${value}`;
}

export function kvLine(key: string, value: string, keyWidth = 14): string {
  return `  ${kv(key, value, keyWidth)}`;
}

// ── Dividers ────────────────────────────────────────────────────

export function divider(width = 56): string {
  return `  ${palette.dark}${'─'.repeat(width)}${palette.reset}`;
}

export function thickDivider(width = 56): string {
  return `  ${gradient('━'.repeat(width), BRAND_STOPS[0], BRAND_STOPS[2])}`;
}

// ── Tagline ─────────────────────────────────────────────────────

export function tagline(): string {
  return subHeader('local-first agent runtime');
}

// ── Version Banner (for boot/startup) ───────────────────────────

export function versionBanner(version: string): string {
  return [
    '',
    banner(),
    `  ${palette.silver}local-first agent runtime${palette.reset} ${palette.dark}·${palette.reset} ${multiGradient(`v${version}`, BRAND_STOPS)} ${palette.dark}·${palette.reset} ${palette.dim}${RELEASE_CODENAME.toLowerCase()}${palette.reset}`,
    '',
  ].join('\n');
}
