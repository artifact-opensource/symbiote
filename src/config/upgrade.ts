// Symbiote — Config upgrade: brings any older symbiote.json up to the current template.
// Pure function first (testable), file wrapper second.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_VERSION, PROVIDER_ENV, SCHEMA_REF, buildConfigTemplate } from './template.js';

export interface UpgradeResult {
  config: Record<string, any>;
  changes: string[];
  /** Secrets lifted out of the config; the caller writes them to .env. */
  secrets: Record<string, string>;
}

const isPlainObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const isEnvRef = (v: unknown): boolean => typeof v === 'string' && /^\$\{\w+\}$/.test(v.trim());

/** Template provides structure and defaults; user values always win. Arrays are replaced, not merged. */
function merge(base: any, override: any): any {
  if (!isPlainObject(base) || !isPlainObject(override)) return override === undefined ? base : override;
  const out: Record<string, any> = { ...base };
  for (const [k, v] of Object.entries(override)) out[k] = k in base ? merge(base[k], v) : v;
  return out;
}

/** Remove keys the current code does not use and empty optional values. */
function prune(value: any, changes: string[], trail = ''): any {
  if (Array.isArray(value)) return value.filter(v => v !== null && v !== undefined);
  if (!isPlainObject(value)) return value;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(value)) {
    if (/mach6|symbiote-core/i.test(k)) { changes.push(`removed legacy key ${trail}${k}`); continue; }
    if (v === null || v === undefined || v === '') { changes.push(`removed empty ${trail}${k}`); continue; }
    out[k] = prune(v, changes, `${trail}${k}.`);
  }
  return out;
}

function relativize(value: unknown, configDir: string, label: string, changes: string[]): unknown {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return value;
  const rel = path.relative(configDir, value);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return value;
  const result = rel === '' ? '.' : rel.replace(/\\/g, '/');
  changes.push(`${label}: absolute path made relative (${result})`);
  return result;
}

export function upgradeConfig(raw: Record<string, any>, opts: { configDir: string; existingEnv?: Record<string, string> }): UpgradeResult {
  const changes: string[] = [];
  const secrets: Record<string, string> = {};
  const env = opts.existingEnv ?? {};

  const input = {
    name: raw.name,
    emoji: raw.emoji,
    provider: raw.defaultProvider,
    model: raw.defaultModel,
    ownerIds: Array.isArray(raw.ownerIds) ? raw.ownerIds : raw.ownerIds ? [String(raw.ownerIds)] : [],
  };
  const merged = merge(buildConfigTemplate(input), { ...raw, ownerIds: input.ownerIds });

  const before = typeof raw.configVersion === 'number' ? raw.configVersion : 1;
  const newKeys = Object.keys(merged).filter(k => !(k in raw) && k !== '$schema' && k !== 'configVersion');
  if (newKeys.length) changes.push(`added sections: ${newKeys.join(', ')}`);

  // Secrets belong in .env, referenced from the config as ${VAR}.
  const lift = (holder: Record<string, any> | undefined, field: string, envName: string, label: string) => {
    const value = holder?.[field];
    if (!holder || typeof value !== 'string' || !value || isEnvRef(value)) return;
    if (env[envName] && env[envName] !== value) { changes.push(`${label}: kept inline (conflicts with ${envName} in .env)`); return; }
    if (!env[envName]) secrets[envName] = value;
    holder[field] = `\${${envName}}`;
    changes.push(`${label}: secret moved to .env as ${envName}`);
  };
  for (const [id, block] of Object.entries<any>(merged.providers ?? {})) {
    const envName = PROVIDER_ENV[id];
    if (envName && isPlainObject(block)) lift(block, 'apiKey', envName, `providers.${id}.apiKey`);
  }
  lift(merged.discord, 'token', 'DISCORD_BOT_TOKEN', 'discord.token');

  merged.workspace = relativize(merged.workspace, opts.configDir, 'workspace', changes);
  merged.sessionsDir = relativize(merged.sessionsDir, opts.configDir, 'sessionsDir', changes);

  for (const key of ['allowedOrigins', 'ownerIds'] as const) {
    if (!Array.isArray(merged[key])) continue;
    const unique = [...new Set(merged[key].map(String))];
    if (unique.length !== merged[key].length) changes.push(`${key}: duplicates removed`);
    merged[key] = unique;
  }

  merged.$schema = SCHEMA_REF;
  merged.configVersion = CONFIG_VERSION;
  if (before < CONFIG_VERSION) changes.push(`configVersion ${before} → ${CONFIG_VERSION}`);

  return { config: prune(merged, changes), changes, secrets };
}

export function readConfigFile(configPath: string): Record<string, any> {
  let text = fs.readFileSync(configPath, 'utf-8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const stripped = text.replace(/"(?:[^"\\]|\\.)*"|\/\/.*$|\/\*[\s\S]*?\*\//gm, m => (m.startsWith('"') ? m : ''));
  return JSON.parse(stripped);
}

export function readEnv(envPath: string): Record<string, string> {
  if (!fs.existsSync(envPath)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_]\w*)\s*=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/** Set or add KEY=value lines in a .env file, preserving everything else. */
export function writeEnvValues(envPath: string, updates: Record<string, string>): void {
  const keys = Object.keys(updates);
  if (!keys.length) return;
  const lines = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8').replace(/\s+$/, '').split(/\r?\n/) : [];
  for (const key of keys) {
    const i = lines.findIndex(l => l.startsWith(`${key}=`));
    if (i >= 0) lines[i] = `${key}=${updates[key]}`; else lines.push(`${key}=${updates[key]}`);
  }
  fs.writeFileSync(envPath, lines.join('\n') + '\n');
  try { fs.chmodSync(envPath, 0o600); } catch { /* not supported on this filesystem */ }
}

/** Copy the JSON schema next to the config so the relative $schema reference resolves in editors. */
export function ensureSchema(configDir: string): void {
  const target = path.join(configDir, 'symbiote.schema.json');
  if (fs.existsSync(target)) return;
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'symbiote.schema.json');
  if (fs.existsSync(source) && path.resolve(source) !== path.resolve(target)) fs.copyFileSync(source, target);
}

export interface UpgradeReport extends Pick<UpgradeResult, 'changes'> {
  changed: boolean;
  backupPath?: string;
  secretsMoved: string[];
}

/** Upgrade a config file in place, keeping a timestamped backup and moving secrets into .env. */
export function upgradeConfigFile(configPath: string, envPath = path.join(path.dirname(configPath), '.env')): UpgradeReport {
  const raw = readConfigFile(configPath);
  const configDir = path.dirname(path.resolve(configPath));
  const { config, changes, secrets } = upgradeConfig(raw, { configDir, existingEnv: readEnv(envPath) });

  const next = JSON.stringify(config, null, 2) + '\n';
  const current = fs.readFileSync(configPath, 'utf-8');
  if (next === current) return { changed: false, changes: [], secretsMoved: [] };

  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const backupPath = `${configPath}.bak-${stamp}`;
  fs.copyFileSync(configPath, backupPath);
  fs.writeFileSync(configPath, next);

  const secretNames = Object.keys(secrets);
  if (secretNames.length) {
    const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
    const sep = existing && !existing.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(envPath, `${sep}${secretNames.map(k => `${k}=${secrets[k]}`).join('\n')}\n`);
  }
  ensureSchema(configDir);
  return { changed: true, changes, backupPath, secretsMoved: secretNames };
}

export function needsUpgrade(configPath: string): boolean {
  try {
    return (readConfigFile(configPath).configVersion ?? 1) < CONFIG_VERSION;
  } catch {
    return false;
  }
}
