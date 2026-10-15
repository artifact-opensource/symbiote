import * as fs from 'node:fs';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SAMPLE_INTERVAL_MS = 3_000;

interface CpuTimes {
  user: number;
  nice: number;
  sys: number;
  idle: number;
  irq: number;
}

export interface HostResourceSnapshot {
  sampledAt: number;
  cpuPercent: number | null;
  cpuLogicalCores: number;
  memory: { totalBytes: number; freeBytes: number; usedPercent: number };
  network: {
    receiveBytesPerSecond: number | null;
    transmitBytesPerSecond: number | null;
    source: string;
  };
  disk: {
    readBytesPerSecond: number | null;
    writeBytesPerSecond: number | null;
    source: string;
  };
  temperature: {
    sensors: Array<{ name: string; celsius: number; source: string }>;
    source: string;
    unavailableReason?: string;
  };
  warnings: string[];
}

interface WindowsCounters {
  network: { receivePerSecond: number; transmitPerSecond: number } | null;
  disk: { readPerSecond: number; writePerSecond: number } | null;
}

const EMPTY_SNAPSHOT: HostResourceSnapshot = {
  sampledAt: 0,
  cpuPercent: null,
  cpuLogicalCores: Math.max(1, os.cpus().length),
  memory: { totalBytes: os.totalmem(), freeBytes: os.freemem(), usedPercent: 0 },
  network: { receiveBytesPerSecond: null, transmitBytesPerSecond: null, source: 'Waiting for a second sample' },
  disk: { readBytesPerSecond: null, writeBytesPerSecond: null, source: 'Waiting for a second sample' },
  temperature: { sensors: [], source: 'Operating-system hardware sensor interface', unavailableReason: 'Waiting for sensor detection' },
  warnings: [],
};

function cpuTotal(times: CpuTimes): number {
  return times.user + times.nice + times.sys + times.idle + times.irq;
}

export function calculateCpuPercent(previous: CpuTimes[], current: CpuTimes[]): number | null {
  if (previous.length === 0 || current.length === 0) return null;
  const coreCount = Math.min(previous.length, current.length);
  let idleDelta = 0;
  let totalDelta = 0;
  for (let index = 0; index < coreCount; index++) {
    const prior = previous[index];
    const next = current[index];
    const delta = cpuTotal(next) - cpuTotal(prior);
    if (delta < 0) continue;
    idleDelta += Math.max(0, next.idle - prior.idle);
    totalDelta += delta;
  }
  return totalDelta > 0 ? Math.round(Math.min(100, Math.max(0, (1 - idleDelta / totalDelta) * 100)) * 10) / 10 : null;
}

export function parseProcNetwork(raw: string): { received: number; sent: number } {
  let received = 0;
  let sent = 0;
  for (const line of raw.split(/\r?\n/).slice(2)) {
    const separator = line.indexOf(':');
    if (separator < 0 || line.slice(0, separator).trim() === 'lo') continue;
    const fields = line.slice(separator + 1).trim().split(/\s+/).map(Number);
    if (fields.length >= 9 && fields.slice(0, 9).every(Number.isFinite)) {
      received += fields[0];
      sent += fields[8];
    }
  }
  return { received, sent };
}

export function parseProcDiskStats(raw: string): { readBytes: number; writtenBytes: number } {
  let readSectors = 0;
  let writtenSectors = 0;
  const wholeDisk = /^(?:sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+|hd[a-z]+)$/;
  for (const line of raw.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    const device = fields[2];
    if (!device || !wholeDisk.test(device) || fields.length < 10) continue;
    const read = Number(fields[5]);
    const written = Number(fields[9]);
    if (Number.isFinite(read)) readSectors += read;
    if (Number.isFinite(written)) writtenSectors += written;
  }
  return { readBytes: readSectors * 512, writtenBytes: writtenSectors * 512 };
}

export function parseWindowsThermalCounter(raw: string): HostResourceSnapshot['temperature']['sensors'] {
  const parsed: unknown = JSON.parse(raw.trim() || '[]');
  const records = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  return records.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const rawTemperature = Number(record.value);
    const celsius = rawTemperature / 100;
    if (!Number.isFinite(celsius) || celsius < -40 || celsius > 150) return [];
    const instance = typeof record.name === 'string' ? record.name : '';
    const zone = instance.match(/TZ(\d+)$/i)?.[1];
    return [{
      name: zone ? `Thermal zone ${zone}` : instance || 'ACPI thermal zone',
      celsius: Math.round(celsius * 10) / 10,
      source: 'Windows ACPI thermal-zone performance counter',
    }];
  });
}

function readLinuxTemperatures(): HostResourceSnapshot['temperature'] {
  const sensors: HostResourceSnapshot['temperature']['sensors'] = [];
  const roots = ['/sys/class/hwmon', '/sys/class/thermal'];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const base = `${root}/${entry}`;
      if (root.endsWith('hwmon')) {
        let chip = entry;
        try { chip = fs.readFileSync(`${base}/name`, 'utf8').trim() || entry; } catch { /* Use the kernel device name. */ }
        let files: string[];
        try { files = fs.readdirSync(base); } catch { continue; }
        for (const file of files.filter(name => /^temp\d+_input$/.test(name))) {
          try {
            const raw = Number(fs.readFileSync(`${base}/${file}`, 'utf8').trim());
            const celsius = raw / 1000;
            if (!Number.isFinite(celsius) || celsius < -40 || celsius > 150) continue;
            const labelFile = file.replace('_input', '_label');
            let label = file.replace('_input', '');
            try { label = fs.readFileSync(`${base}/${labelFile}`, 'utf8').trim() || label; } catch { /* The label is optional. */ }
            sensors.push({ name: `${chip} · ${label}`, celsius: Math.round(celsius * 10) / 10, source: 'Linux hwmon sysfs' });
          } catch { /* A sensor may disappear while the kernel updates its device tree. */ }
        }
      } else {
        try {
          const raw = Number(fs.readFileSync(`${base}/temp`, 'utf8').trim());
          const celsius = raw / 1000;
          if (!Number.isFinite(celsius) || celsius < -40 || celsius > 150) continue;
          let label = entry;
          try { label = fs.readFileSync(`${base}/type`, 'utf8').trim() || label; } catch { /* The zone type is optional. */ }
          sensors.push({ name: label, celsius: Math.round(celsius * 10) / 10, source: 'Linux thermal-zone sysfs' });
        } catch { /* Not every thermal-zone entry exposes a readable temperature. */ }
      }
    }
  }
  return sensors.length
    ? { sensors, source: 'Linux kernel hardware sensors (sysfs)' }
    : { sensors: [], source: 'Linux kernel hardware sensors (sysfs)', unavailableReason: 'No readable hwmon or thermal-zone sensors were exposed by the operating system.' };
}

async function readWindowsCounters(): Promise<WindowsCounters> {
  const script = [
    "$ProgressPreference='SilentlyContinue'; $WarningPreference='SilentlyContinue'",
    "$samples=(Get-Counter -Counter '\\Network Interface(*)\\Bytes Received/sec','\\Network Interface(*)\\Bytes Sent/sec','\\PhysicalDisk(_Total)\\Disk Read Bytes/sec','\\PhysicalDisk(_Total)\\Disk Write Bytes/sec' -ErrorAction Stop).CounterSamples",
    "$networkSamples=$samples | Where-Object {$_.InstanceName -notmatch 'Loopback|isatap|Teredo'}",
    "$rx=($networkSamples | Where-Object {$_.Path -match 'bytes received/sec'} | Measure-Object -Property CookedValue -Sum).Sum",
    "$tx=($networkSamples | Where-Object {$_.Path -match 'bytes sent/sec'} | Measure-Object -Property CookedValue -Sum).Sum",
    "$read=($samples | Where-Object {$_.Path -match 'disk read bytes/sec'} | Measure-Object -Property CookedValue -Sum).Sum",
    "$write=($samples | Where-Object {$_.Path -match 'disk write bytes/sec'} | Measure-Object -Property CookedValue -Sum).Sum",
    "[pscustomobject]@{network=@{receivePerSecond=[double]$rx; transmitPerSecond=[double]$tx}; disk=@{readPerSecond=[double]$read; writePerSecond=[double]$write}} | ConvertTo-Json -Compress -Depth 4",
  ].join('; ');
  const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    timeout: 8_000,
    windowsHide: true,
    maxBuffer: 128 * 1024,
  });
  const parsed: unknown = JSON.parse(stdout.trim());
  if (!parsed || typeof parsed !== 'object') throw new Error('Windows performance counters returned an invalid payload.');
  const value = parsed as Record<string, unknown>;
  const network = value.network as Record<string, unknown> | null;
  const disk = value.disk as Record<string, unknown> | null;
  return {
    network: network && Number.isFinite(network.receivePerSecond) && Number.isFinite(network.transmitPerSecond)
      ? { receivePerSecond: Number(network.receivePerSecond), transmitPerSecond: Number(network.transmitPerSecond) }
      : null,
    disk: disk && Number.isFinite(disk.readPerSecond) && Number.isFinite(disk.writePerSecond)
      ? { readPerSecond: Number(disk.readPerSecond), writePerSecond: Number(disk.writePerSecond) }
      : null,
  };
}

async function readWindowsTemperature(): Promise<HostResourceSnapshot['temperature']> {
  try {
    const script = "$ErrorActionPreference='Stop'; @(Get-Counter -Counter '\\Thermal Zone Information(*)\\High Precision Temperature' -ErrorAction Stop | Select-Object -ExpandProperty CounterSamples | ForEach-Object {@{name=[string]$_.InstanceName; value=[double]$_.CookedValue}}) | ConvertTo-Json -Compress -Depth 3";
    const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: 5_000,
      windowsHide: true,
      maxBuffer: 64 * 1024,
    });
    const sensors = parseWindowsThermalCounter(stdout);
    return sensors.length
      ? { sensors, source: 'Windows ACPI thermal-zone counters (not a guaranteed CPU-core sensor)' }
      : { sensors: [], source: 'Windows hardware temperature sensors', unavailableReason: 'No readable temperature sensor is exposed by Windows on this device.' };
  } catch {
    return {
      sensors: [],
      source: 'Windows hardware temperature sensors',
      unavailableReason: 'No readable temperature sensor is exposed by Windows on this device.',
    };
  }
}

export class SystemResourcesSampler {
  private value: HostResourceSnapshot = { ...EMPTY_SNAPSHOT };
  private previousCpu = os.cpus().map(cpu => cpu.times);
  private previousNetwork: { received: number; sent: number; at: number } | null = null;
  private previousDisk: { readBytes: number; writtenBytes: number; at: number } | null = null;
  private timer: ReturnType<typeof setInterval>;
  private temperatureTimer: ReturnType<typeof setInterval> | null = null;
  private sampling = false;

  constructor() {
    void this.sample();
    this.timer = setInterval(() => void this.sample(), SAMPLE_INTERVAL_MS);
    this.timer.unref?.();
    if (process.platform === 'win32') {
      void this.refreshTemperature();
      this.temperatureTimer = setInterval(() => void this.refreshTemperature(), 60_000);
      this.temperatureTimer.unref?.();
    }
  }

  snapshot(): HostResourceSnapshot {
    return {
      ...this.value,
      memory: { ...this.value.memory },
      network: { ...this.value.network },
      disk: { ...this.value.disk },
      temperature: { ...this.value.temperature, sensors: this.value.temperature.sensors.map(sensor => ({ ...sensor })) },
      warnings: [...this.value.warnings],
    };
  }

  stop(): void {
    clearInterval(this.timer);
    if (this.temperatureTimer) clearInterval(this.temperatureTimer);
  }

  private async sample(): Promise<void> {
    if (this.sampling) return;
    this.sampling = true;
    const now = Date.now();
    const cpu = os.cpus();
    const currentCpu = cpu.map(core => core.times);
    const totalBytes = os.totalmem();
    const freeBytes = os.freemem();
    const warnings: string[] = [];
    let network = { receiveBytesPerSecond: this.value.network.receiveBytesPerSecond, transmitBytesPerSecond: this.value.network.transmitBytesPerSecond, source: this.value.network.source };
    let disk = { readBytesPerSecond: this.value.disk.readBytesPerSecond, writeBytesPerSecond: this.value.disk.writeBytesPerSecond, source: this.value.disk.source };
    let temperature = this.value.temperature;

    try {
      if (process.platform === 'linux') {
        try {
          const counters = parseProcNetwork(fs.readFileSync('/proc/net/dev', 'utf8'));
          if (this.previousNetwork) {
            const seconds = Math.max(0.001, (now - this.previousNetwork.at) / 1000);
            network = {
              receiveBytesPerSecond: Math.max(0, (counters.received - this.previousNetwork.received) / seconds),
              transmitBytesPerSecond: Math.max(0, (counters.sent - this.previousNetwork.sent) / seconds),
              source: '/proc/net/dev · all non-loopback interfaces',
            };
          } else network = { ...network, source: 'Linux network counters · waiting for rate sample' };
          this.previousNetwork = { ...counters, at: now };
        } catch (failure) {
          warnings.push(`Network counters unavailable: ${failure instanceof Error ? failure.message : String(failure)}`);
        }
        try {
          const counters = parseProcDiskStats(fs.readFileSync('/proc/diskstats', 'utf8'));
          if (this.previousDisk) {
            const seconds = Math.max(0.001, (now - this.previousDisk.at) / 1000);
            disk = {
              readBytesPerSecond: Math.max(0, (counters.readBytes - this.previousDisk.readBytes) / seconds),
              writeBytesPerSecond: Math.max(0, (counters.writtenBytes - this.previousDisk.writtenBytes) / seconds),
              source: '/proc/diskstats · whole block devices',
            };
          } else disk = { ...disk, source: 'Linux disk counters · waiting for rate sample' };
          this.previousDisk = { ...counters, at: now };
        } catch (failure) {
          warnings.push(`Disk counters unavailable: ${failure instanceof Error ? failure.message : String(failure)}`);
        }
        temperature = readLinuxTemperatures();
      } else if (process.platform === 'win32') {
        const counters = await readWindowsCounters();
        if (counters.network) {
          network = {
            receiveBytesPerSecond: Math.max(0, counters.network.receivePerSecond),
            transmitBytesPerSecond: Math.max(0, counters.network.transmitPerSecond),
            source: 'Windows Performance Counters · active non-loopback interfaces',
          };
        } else network = { ...network, source: 'Windows network adapter counters unavailable' };
        if (counters.disk) disk = {
          readBytesPerSecond: counters.disk.readPerSecond,
          writeBytesPerSecond: counters.disk.writePerSecond,
          source: 'Win32_PerfFormattedData_PerfDisk_PhysicalDisk · _Total',
        };
      } else {
        temperature = {
          sensors: [],
          source: 'Operating-system hardware sensor interface',
          unavailableReason: 'This platform does not expose a supported thermal sensor interface to Symbiote.',
        };
      }
    } catch (failure) {
      const reason = failure && typeof failure === 'object' && 'stderr' in failure
        ? String(failure.stderr ?? '').trim()
        : failure instanceof Error ? failure.message : String(failure);
      warnings.push(`Hardware counters could not be sampled: ${reason || 'Windows counter query failed.'}`);
    } finally {
      const cpuPercent = calculateCpuPercent(this.previousCpu, currentCpu);
      this.previousCpu = currentCpu;
      this.value = {
        sampledAt: now,
        cpuPercent,
        cpuLogicalCores: Math.max(1, cpu.length),
        memory: {
          totalBytes,
          freeBytes,
          usedPercent: totalBytes > 0 ? Math.round(((totalBytes - freeBytes) / totalBytes) * 10_000) / 100 : 0,
        },
        network,
        disk,
        temperature,
        warnings,
      };
      this.sampling = false;
    }
  }

  private async refreshTemperature(): Promise<void> {
    this.value = { ...this.value, temperature: await readWindowsTemperature() };
  }
}
