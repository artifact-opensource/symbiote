import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const STATE_FILE = 'tailscale-access.json';

export interface TailscaleDeviceStatus {
  connected: boolean;
  ip: string | null;
  error?: string;
}

export interface TailscaleIntegrationStatus extends TailscaleDeviceStatus {
  enabled: boolean;
  mode: 'lan' | 'tailscale';
  accessUrl: string;
}

interface TailscaleCliStatus {
  BackendState?: unknown;
  Self?: {
    TailscaleIPs?: unknown;
  };
}

function isTailscaleIPv4(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const octets = value.split('.');
  if (octets.length !== 4 || octets.some(octet => !/^\d{1,3}$/.test(octet))) return false;
  const [first, second, third, fourth] = octets.map(Number);
  return [first, second, third, fourth].every(octet => octet >= 0 && octet <= 255)
    && first === 100 && second >= 64 && second <= 127;
}

function tailscaleExecutables(): string[] {
  if (process.platform !== 'win32') return ['tailscale'];
  return [
    'tailscale.exe',
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Tailscale', 'tailscale.exe'),
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Tailscale', 'tailscale.exe'),
  ];
}

export async function detectTailscaleDevice(): Promise<TailscaleDeviceStatus> {
  let lastError: unknown;
  for (const executable of tailscaleExecutables()) {
    try {
      const { stdout } = await execFileAsync(executable, ['status', '--json'], {
        timeout: 5_000,
        windowsHide: true,
        maxBuffer: 128 * 1024,
      });
      let status: TailscaleCliStatus;
      try {
        status = JSON.parse(stdout) as TailscaleCliStatus;
      } catch (failure) {
        throw new Error('Tailscale returned invalid status JSON.', { cause: failure });
      }
      const addresses = Array.isArray(status.Self?.TailscaleIPs) ? status.Self.TailscaleIPs : [];
      const ip = addresses.find(isTailscaleIPv4) ?? null;
      const connected = status.BackendState === 'Running' && ip !== null;
      return {
        connected,
        ip,
        ...(!connected ? { error: 'Tailscale is installed but this device is not connected to the tailnet.' } : {}),
      };
    } catch (failure) {
      lastError = failure;
      const code = failure && typeof failure === 'object' && 'code' in failure
        ? String(failure.code)
        : '';
      if (code === 'ENOENT') continue;
      const message = failure instanceof Error ? failure.message : String(failure);
      return { connected: false, ip: null, error: `Could not read Tailscale status: ${message}` };
    }
  }

  const message = lastError instanceof Error && !('code' in lastError && lastError.code === 'ENOENT')
    ? lastError.message
    : 'Tailscale CLI was not found. Install Tailscale and sign in before enabling tailnet access.';
  return { connected: false, ip: null, error: message };
}

export function readTailscaleAccessEnabled(sessionDirectory: string): boolean {
  const statePath = path.join(sessionDirectory, STATE_FILE);
  let content: string;
  try {
    content = fs.readFileSync(statePath, 'utf8');
  } catch (failure) {
    if ((failure as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new Error(`Could not read Tailscale access settings at ${statePath}.`, { cause: failure });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (failure) {
    throw new Error(`Tailscale access settings at ${statePath} are invalid JSON.`, { cause: failure });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || (parsed as { version?: unknown }).version !== 1
    || typeof (parsed as { enabled?: unknown }).enabled !== 'boolean') {
    throw new Error(`Tailscale access settings at ${statePath} have an unsupported format.`);
  }
  return (parsed as { enabled: boolean }).enabled;
}

export function writeTailscaleAccessEnabled(sessionDirectory: string, enabled: boolean): void {
  const statePath = path.join(sessionDirectory, STATE_FILE);
  fs.mkdirSync(sessionDirectory, { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify({ version: 1, enabled })}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    fs.renameSync(temporaryPath, statePath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

function findLanIPv4(): string {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal || isTailscaleIPv4(address.address)) continue;
      return address.address;
    }
  }
  return '127.0.0.1';
}

export async function getTailscaleIntegrationStatus(
  sessionDirectory: string,
  webPort: number,
): Promise<TailscaleIntegrationStatus> {
  const enabled = readTailscaleAccessEnabled(sessionDirectory);
  const device = await detectTailscaleDevice();
  const mode = enabled ? 'tailscale' : 'lan';
  const accessUrl = enabled
    ? device.connected && device.ip ? `http://${device.ip}:${webPort}` : ''
    : `http://${findLanIPv4()}:${webPort}`;
  return {
    ...device,
    enabled,
    mode,
    accessUrl,
  };
}
