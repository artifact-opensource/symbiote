/**
 * Symbiote — Brand Kit
 * Visual identity for CLI surfaces. Colors, logos, formatting.
 * 
 * Built by Artifact Virtual.
 */

// ── ANSI 256-Color + True Color Helpers ─────────────────────────

// True color: \x1b[38;2;r;g;bm (foreground)
const rgb = (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`;
const bgRgb = (r: number, g: number, b: number) => `\x1b[48;2;${r};${g};${b}m`;

// ── Brand Palette ───────────────────────────────────────────────

export const palette = {
  // Primary — electric violet to deep purple
  violet:      rgb(138, 43, 226),
  purple:      rgb(106, 13, 173),
  deepPurple:  rgb(75, 0, 130),

  // Accent — molten gold
  gold:        rgb(255, 193, 37),
  amber:       rgb(255, 160, 0),
  warmGold:    rgb(218, 165, 32),

  // Energy — electric cyan / teal
  cyan:        rgb(0, 229, 255),
  teal:        rgb(0, 188, 212),
  ice:         rgb(178, 235, 242),

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
  reset:       '\x1b[0m',
  bold:        '\x1b[1m',
  dim_attr:    '\x1b[2m',
  italic:      '\x1b[3m',
  underline:   '\x1b[4m',
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

/**
 * The Symbiote banner — compact, striking.
 * Each line gets the violet→cyan→gold gradient.
 */
export function banner(): string {
  const lines = [
    '                          __   _____ ',
    '   ____ ___  ____ ______ / /_ / ___/ ',
    '  / __ `__ \\/ __ `/ ___/ __ \\/ __ \\  ',
    ' / / / / / / /_/ / /__/ / / / /_/ /  ',
    '/_/ /_/ /_/\\__,_/\\___/_/ /_/\\____/   ',
  ];

  const stops: [number, number, number][] = [
    [138, 43, 226],   // violet
    [0, 229, 255],    // cyan
    [255, 193, 37],   // gold
  ];

  return lines.map(line => multiGradient(line, stops)).join('\n');
}

/**
 * Compact one-line logo for prompts and headers.
 */
export function logo(): string {
  return `${palette.bold}${gradient('⚡ Symbiote', [138, 43, 226], [0, 229, 255])}${palette.reset}`;
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
    ? `${borderColor}╭─ ${palette.reset}${opts.title}${borderColor} ${'─'.repeat(Math.max(0, innerWidth - stripAnsi(opts.title).length - 3))}╮${palette.reset}`
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
  const gradTitle = gradient(title, [138, 43, 226], [0, 229, 255]);
  const line = palette.dim + '─'.repeat(Math.max(0, 52 - title.length)) + palette.reset;
  return `\n  ${palette.bold}${gradTitle}${palette.reset} ${line}\n`;
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

  const bar = gradient('█'.repeat(filled), [138, 43, 226], [0, 229, 255])
    + palette.dark + '░'.repeat(empty) + palette.reset;

  return `  ${bar} ${palette.silver}${current}/${total}${palette.reset}`;
}

// ── Key-Value Display ───────────────────────────────────────────

export function kvLine(key: string, value: string, keyWidth = 14): string {
  const paddedKey = key.padEnd(keyWidth);
  return `  ${palette.silver}${paddedKey}${palette.reset} ${value}`;
}

// ── Dividers ────────────────────────────────────────────────────

export function divider(width = 56): string {
  return `  ${palette.dark}${'─'.repeat(width)}${palette.reset}`;
}

export function thickDivider(width = 56): string {
  return `  ${gradient('━'.repeat(width), [75, 0, 130], [0, 188, 212])}`;
}

// ── Tagline ─────────────────────────────────────────────────────

export function tagline(): string {
  return subHeader('AI agent framework · artifact virtual');
}

// ── Version Banner (for boot/startup) ───────────────────────────

export function versionBanner(version: string): string {
  const ver = `v${version}`;
  return [
    '',
    banner(),
    '',
    `  ${palette.bold}${gradient(ver, [255, 193, 37], [255, 160, 0])}${palette.reset}  ${palette.dim_attr}${palette.silver}· AI agent framework${palette.reset}`,
    `  ${palette.dim_attr}${palette.dim}artifact virtual · artifactvirtual.com${palette.reset}`,
    '',
    thickDivider(),
    '',
  ].join('\n');
}
