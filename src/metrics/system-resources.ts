import * as fs from 'node:fs';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SAMPLE_INTERVAL_MS = 3_000;
const WINDOWS_COUNTERS_REFRESH_INTERVAL_MS = 15_000;

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
  cpuCorePercents: Array<number | null>;
  gpu: GpuResourceSnapshot;
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

export interface GpuResourceSnapshot {
  state: 'detecting' | 'available' | 'unavailable';
  devices: Array<{ name: string }>;
  loadPercent: number | null;
  dedicatedMemoryUsedBytes: number | null;
  dedicatedMemoryTotalBytes: number | null;
  sharedMemoryUsedBytes: number | null;
  source: string;
  unavailableReason?: string;
}

interface WindowsCounters {
  network: { receivePerSecond: number; transmitPerSecond: number } | null;
  disk: { readPerSecond: number; writePerSecond: number } | null;
  unavailableReason?: string;
}

let windowsCountersCache: { sampledAt: number; value: WindowsCounters } | null = null;
let windowsCountersPending: Promise<WindowsCounters> | null = null;

const EMPTY_SNAPSHOT: HostResourceSnapshot = {
  sampledAt: 0,
  cpuPercent: null,
  cpuLogicalCores: Math.max(1, os.cpus().length),
  cpuCorePercents: [],
  gpu: {
    state: 'detecting',
    devices: [],
    loadPercent: null,
    dedicatedMemoryUsedBytes: null,
    dedicatedMemoryTotalBytes: null,
    sharedMemoryUsedBytes: null,
    source: 'GPU adapter detection',
  },
  memory: { totalBytes: os.totalmem(), freeBytes: os.freemem(), usedPercent: 0 },
  network: { receiveBytesPerSecond: null, transmitBytesPerSecond: null, source: 'Waiting for a second sample' },
  disk: { readBytesPerSecond: null, writeBytesPerSecond: null, source: 'Waiting for a second sample' },
  temperature: { sensors: [], source: 'Operating-system hardware sensor interface', unavailableReason: 'Waiting for sensor detection' },
  warnings: [],
};

function unavailableGpu(reason: string): GpuResourceSnapshot {
  return {
    state: 'unavailable',
    devices: [],
    loadPercent: null,
    dedicatedMemoryUsedBytes: null,
    dedicatedMemoryTotalBytes: null,
    sharedMemoryUsedBytes: null,
    source: 'Operating-system GPU telemetry',
    unavailableReason: reason,
  };
}

function commandFailureReason(failure: unknown, timeoutMs: number): string {
  if (failure && typeof failure === 'object') {
    const commandError = failure as {
      code?: unknown;
      killed?: unknown;
      signal?: unknown;
      stderr?: unknown;
    };
    if (commandError.code === 'ETIMEDOUT' || commandError.killed === true) {
      return `Windows telemetry query timed out after ${timeoutMs} ms.`;
    }
    const stderr = String(commandError.stderr ?? '').trim();
    if (stderr) return stderr;
    if (commandError.code !== undefined) {
      return `Windows telemetry query exited with code ${String(commandError.code)}.`;
    }
    if (commandError.signal) {
      return `Windows telemetry query was terminated by ${String(commandError.signal)}.`;
    }
  }
  return failure instanceof Error ? failure.message : String(failure);
}

function finitePercent(value: unknown): number | null {
  const percent = Number(value);
  return Number.isFinite(percent) ? Math.round(Math.max(0, Math.min(100, percent)) * 10) / 10 : null;
}

function finiteBytes(value: unknown): number | null {
  const bytes = Number(value);
  return Number.isFinite(bytes) && bytes >= 0 ? bytes : null;
}

function records(value: unknown): Array<Record<string, unknown>> {
  const items = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return items.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null);
}

export function parseNvidiaGpuCounters(raw: string): GpuResourceSnapshot {
  const devices = raw.split(/\r?\n/).flatMap(line => {
    const [name, load, used, total] = line.split(',').map(value => value.trim());
    if (!name) return [];
    const megabytesToBytes = (value: string | undefined) => {
      const megabytes = Number(value);
      return Number.isFinite(megabytes) && megabytes >= 0 ? megabytes * 1024 * 1024 : null;
    };
    return [{
      name,
      loadPercent: finitePercent(load),
      usedBytes: megabytesToBytes(used),
      totalBytes: megabytesToBytes(total),
    }];
  });
  if (!devices.length) return unavailableGpu('No supported GPU adapter was detected.');
  const dedicatedMemoryUsedBytes = devices.every(device => device.usedBytes !== null)
    ? devices.reduce((sum, device) => sum + (device.usedBytes ?? 0), 0)
    : null;
  const dedicatedMemoryTotalBytes = devices.every(device => device.totalBytes !== null)
    ? devices.reduce((sum, device) => sum + (device.totalBytes ?? 0), 0)
    : null;
  return {
    state: 'available',
    devices: devices.map(device => ({ name: device.name })),
    loadPercent: devices.some(device => device.loadPercent !== null)
      ? Math.max(...devices.flatMap(device => device.loadPercent === null ? [] : [device.loadPercent]))
      : null,
    dedicatedMemoryUsedBytes,
    dedicatedMemoryTotalBytes,
    sharedMemoryUsedBytes: null,
    source: 'NVIDIA Management Library (nvidia-smi)',
  };
}

export function parseWindowsGpuCounters(raw: string): GpuResourceSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return unavailableGpu('Windows returned invalid GPU counter data.');
  }
  if (!parsed || typeof parsed !== 'object') return unavailableGpu('Windows returned no GPU counter data.');
  const payload = parsed as Record<string, unknown>;
  const adapters = records(payload.adapters).filter(adapter =>
    typeof adapter.name === 'string'
      && adapter.name.trim()
      && !/Microsoft Basic (?:Display|Render) Driver/i.test(adapter.name),
  );
  if (!adapters.length) return unavailableGpu('No GPU adapter was detected by Windows.');
  const engineCountersAvailable = payload.engineCountersAvailable === true;

  const engineTotals = new Map<string, Map<string, number>>();
  for (const sample of records(payload.engines)) {
    if (typeof sample.name !== 'string') continue;
    const match = sample.name.match(/luid_(.+?)_phys_(\d+)_eng_(\d+)_engtype_/i);
    const value = Number(sample.value);
    if (!match || !Number.isFinite(value) || value < 0) continue;
    const adapterId = `${match[1]}_phys_${match[2]}`;
    const engineId = match[3];
    const engines = engineTotals.get(adapterId) ?? new Map<string, number>();
    engines.set(engineId, (engines.get(engineId) ?? 0) + value);
    engineTotals.set(adapterId, engines);
  }
  const perAdapterLoad = [...engineTotals.values()].flatMap(engines => {
    const load = Math.max(...engines.values());
    return Number.isFinite(load) ? [Math.min(100, load)] : [];
  });

  let dedicatedMemoryUsedBytes = 0;
  let sharedMemoryUsedBytes = 0;
  let hasDedicatedMemory = false;
  let hasSharedMemory = false;
  for (const sample of records(payload.memory)) {
    const value = finiteBytes(sample.value);
    if (typeof sample.name !== 'string' || value === null) continue;
    if (typeof sample.counter === 'string' && /dedicated usage$/i.test(sample.counter)) {
      dedicatedMemoryUsedBytes += value;
      hasDedicatedMemory = true;
    } else if (typeof sample.counter === 'string' && /shared usage$/i.test(sample.counter)) {
      sharedMemoryUsedBytes += value;
      hasSharedMemory = true;
    }
  }
  const dedicatedMemoryTotalBytes = adapters.reduce(
    (sum, adapter) => sum + (finiteBytes(adapter.dedicatedTotalBytes) ?? 0),
    0,
  );
  return {
    state: 'available',
    devices: adapters.map(adapter => ({ name: String(adapter.name).trim() })),
    loadPercent: perAdapterLoad.length ? Math.max(...perAdapterLoad) : engineCountersAvailable ? 0 : null,
    dedicatedMemoryUsedBytes: hasDedicatedMemory ? dedicatedMemoryUsedBytes : null,
    dedicatedMemoryTotalBytes: dedicatedMemoryTotalBytes > 0 ? dedicatedMemoryTotalBytes : null,
    sharedMemoryUsedBytes: hasSharedMemory ? sharedMemoryUsedBytes : null,
    source: 'Windows GPU Engine and Adapter Memory performance counters',
    ...(engineCountersAvailable || perAdapterLoad.length || hasDedicatedMemory || hasSharedMemory
      ? {}
      : { unavailableReason: 'GPU detected, but Windows did not expose utilization or memory counters.' }),
  };
}

async function readNvidiaGpu(): Promise<GpuResourceSnapshot | undefined> {
  try {
    const { stdout } = await execFileAsync('nvidia-smi', [
      '--query-gpu=name,utilization.gpu,memory.used,memory.total',
      '--format=csv,noheader,nounits',
    ], { timeout: 5_000, windowsHide: true, maxBuffer: 64 * 1024 });
    const snapshot = parseNvidiaGpuCounters(stdout);
    return snapshot.state === 'available' ? snapshot : undefined;
  } catch {
    return undefined;
  }
}

async function readWindowsGpu(): Promise<GpuResourceSnapshot> {
  const script = [
    "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'",
    "$adapters=@(Get-CimInstance Win32_VideoController | Where-Object {$_.Name -and $_.Name -notmatch 'Microsoft Basic (Display|Render) Driver'} | ForEach-Object {@{name=[string]$_.Name; dedicatedTotalBytes=[double]$_.AdapterRAM}})",
    "$engines=@(); $memory=@(); $engineCountersAvailable=$false",
    "try {$engines=@(Get-CimInstance -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -Filter \"UtilizationPercentage > 0 AND (Name LIKE '%engtype_3D%' OR Name LIKE '%engtype_Compute%' OR Name LIKE '%engtype_Copy%' OR Name LIKE '%engtype_VideoDecode%' OR Name LIKE '%engtype_VideoEncode%' OR Name LIKE '%engtype_VideoProcessing%')\" | ForEach-Object {@{name=[string]$_.Name; value=[double]$_.UtilizationPercentage}}); $engineCountersAvailable=$true} catch {}",
    "try {$memory=@(Get-CimInstance -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory | ForEach-Object {@{name=[string]$_.Name; counter='Dedicated Usage'; value=[double]$_.DedicatedUsage},@{name=[string]$_.Name; counter='Shared Usage'; value=[double]$_.SharedUsage}})} catch {}",
    "[pscustomobject]@{adapters=$adapters; engines=$engines; memory=$memory; engineCountersAvailable=$engineCountersAvailable} | ConvertTo-Json -Compress -Depth 5",
  ].join('; ');
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: 15_000,
      windowsHide: true,
      maxBuffer: 256 * 1024,
    });
    return parseWindowsGpuCounters(stdout);
  } catch (failure) {
    const reason = commandFailureReason(failure, 15_000);
    return unavailableGpu(`GPU detection failed: ${reason}`);
  }
}

function readLinuxGpu(): GpuResourceSnapshot {
  let cards: string[];
  try {
    cards = fs.readdirSync('/sys/class/drm').filter(entry => /^card\d+$/.test(entry));
  } catch {
    return unavailableGpu('Linux did not expose GPU adapters through DRM sysfs.');
  }
  const devices = cards.flatMap((card, index) => {
    const base = `/sys/class/drm/${card}/device`;
    try {
      const vendor = fs.readFileSync(`${base}/vendor`, 'utf8').trim().toLowerCase();
      const product = fs.readFileSync(`${base}/device`, 'utf8').trim().toLowerCase();
      const vendorNames: Record<string, string> = {
        '0x1002': 'AMD',
        '0x10de': 'NVIDIA',
        '0x8086': 'Intel',
      };
      const vendorName = (vendorNames[vendor] ?? vendor) || 'Unknown';
      const name = `${vendorName} GPU ${product} · Adapter ${index + 1}`;
      const readMetric = (file: string) => {
        try {
          const value = Number(fs.readFileSync(`${base}/${file}`, 'utf8').trim());
          return Number.isFinite(value) && value >= 0 ? value : null;
        } catch {
          return null;
        }
      };
      return [{
        name,
        loadPercent: finitePercent(readMetric('gpu_busy_percent')),
        usedBytes: readMetric('mem_info_vram_used'),
        totalBytes: readMetric('mem_info_vram_total'),
      }];
    } catch {
      return [];
    }
  });
  if (!devices.length) return unavailableGpu('No GPU adapter was detected by Linux DRM.');
  return {
    state: 'available',
    devices: devices.map(device => ({ name: device.name })),
    loadPercent: devices.some(device => device.loadPercent !== null)
      ? Math.max(...devices.flatMap(device => device.loadPercent === null ? [] : [device.loadPercent]))
      : null,
    dedicatedMemoryUsedBytes: devices.every(device => device.usedBytes !== null)
      ? devices.reduce((sum, device) => sum + (device.usedBytes ?? 0), 0)
      : null,
    dedicatedMemoryTotalBytes: devices.every(device => device.totalBytes !== null)
      ? devices.reduce((sum, device) => sum + (device.totalBytes ?? 0), 0)
      : null,
    sharedMemoryUsedBytes: null,
    source: 'Linux DRM sysfs GPU counters',
    ...(devices.some(device => device.loadPercent !== null || device.usedBytes !== null)
      ? {}
      : { unavailableReason: 'GPU detected, but this driver does not expose load or memory counters.' }),
  };
}

async function readMacGpu(): Promise<GpuResourceSnapshot> {
  try {
    const { stdout } = await execFileAsync('system_profiler', ['SPDisplaysDataType', '-json'], {
      timeout: 10_000,
      windowsHide: true,
      maxBuffer: 256 * 1024,
    });
    const parsed: unknown = JSON.parse(stdout);
    const root = parsed as { SPDisplaysDataType?: Array<Record<string, unknown>> };
    const devices = (root.SPDisplaysDataType ?? []).flatMap(display =>
      typeof display.sppci_model === 'string' ? [{ name: display.sppci_model }] : [],
    );
    return devices.length
      ? {
        state: 'available',
        devices,
        loadPercent: null,
        dedicatedMemoryUsedBytes: null,
        dedicatedMemoryTotalBytes: null,
        sharedMemoryUsedBytes: null,
        source: 'macOS System Information',
        unavailableReason: 'macOS does not expose GPU load counters through System Information.',
      }
      : unavailableGpu('No GPU adapter was detected by macOS.');
  } catch (failure) {
    return unavailableGpu(`GPU detection failed: ${failure instanceof Error ? failure.message : String(failure)}`);
  }
}

async function readGpuSnapshot(): Promise<GpuResourceSnapshot> {
  const nvidia = await readNvidiaGpu();
  if (nvidia) return nvidia;
  if (process.platform === 'win32') return readWindowsGpu();
  if (process.platform === 'linux') return readLinuxGpu();
  if (process.platform === 'darwin') return readMacGpu();
  return unavailableGpu(`GPU detection is unsupported on ${process.platform}.`);
}

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

export function calculateCpuCorePercents(previous: CpuTimes[], current: CpuTimes[]): Array<number | null> {
  return current.map((next, index) => {
    const prior = previous[index];
    if (!prior) return null;
    const delta = cpuTotal(next) - cpuTotal(prior);
    if (delta <= 0) return null;
    const idleDelta = Math.max(0, next.idle - prior.idle);
    return Math.round(Math.min(100, Math.max(0, (1 - idleDelta / delta) * 100)) * 10) / 10;
  });
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
    "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'",
    "$network=@(Get-CimInstance -ClassName Win32_PerfFormattedData_Tcpip_NetworkInterface -ErrorAction Stop | Where-Object {$_.Name -notmatch 'Loopback|isatap|Teredo'})",
    "$disk=Get-CimInstance -ClassName Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter \"Name='_Total'\" -ErrorAction Stop",
    "$rx=($network | Measure-Object -Property BytesReceivedPersec -Sum).Sum",
    "$tx=($network | Measure-Object -Property BytesSentPersec -Sum).Sum",
    "$read=[double]$disk.DiskReadBytesPersec",
    "$write=[double]$disk.DiskWriteBytesPersec",
    "[pscustomobject]@{network=@{receivePerSecond=[double]$rx; transmitPerSecond=[double]$tx}; disk=@{readPerSecond=[double]$read; writePerSecond=[double]$write}} | ConvertTo-Json -Compress -Depth 4",
  ].join('; ');
  const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    timeout: 15_000,
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

function readCachedWindowsCounters(): Promise<WindowsCounters> {
  const now = Date.now();
  if (windowsCountersCache) {
    if (now - windowsCountersCache.sampledAt < WINDOWS_COUNTERS_REFRESH_INTERVAL_MS) {
      return Promise.resolve(windowsCountersCache.value);
    }
  }
  if (windowsCountersPending) return windowsCountersPending;

  const pending = readWindowsCounters()
    .catch(failure => ({
      network: null,
      disk: null,
      unavailableReason: commandFailureReason(failure, 15_000),
    }))
    .then(value => {
      windowsCountersCache = { sampledAt: Date.now(), value };
      return value;
    });
  windowsCountersPending = pending.finally(() => {
    windowsCountersPending = null;
  });
  return windowsCountersPending;
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
  private gpuTimer: ReturnType<typeof setInterval>;
  private sampling = false;
  private refreshingGpu = false;

  constructor() {
    void this.sample();
    this.timer = setInterval(() => void this.sample(), SAMPLE_INTERVAL_MS);
    this.timer.unref?.();
    void this.refreshGpu();
    this.gpuTimer = setInterval(() => void this.refreshGpu(), 15_000);
    this.gpuTimer.unref?.();
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
      gpu: { ...this.value.gpu, devices: this.value.gpu.devices.map(device => ({ ...device })) },
      network: { ...this.value.network },
      disk: { ...this.value.disk },
      temperature: { ...this.value.temperature, sensors: this.value.temperature.sensors.map(sensor => ({ ...sensor })) },
      warnings: [...this.value.warnings],
    };
  }

  stop(): void {
    clearInterval(this.timer);
    clearInterval(this.gpuTimer);
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
        const counters = await readCachedWindowsCounters();
        if (counters.unavailableReason) {
          warnings.push(`Hardware counters could not be sampled: ${counters.unavailableReason}`);
        }
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
      const cpuCorePercents = calculateCpuCorePercents(this.previousCpu, currentCpu);
      this.previousCpu = currentCpu;
      this.value = {
        sampledAt: now,
        cpuPercent,
        cpuLogicalCores: Math.max(1, cpu.length),
        cpuCorePercents,
        gpu: this.value.gpu,
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

  private async refreshGpu(): Promise<void> {
    if (this.refreshingGpu) return;
    this.refreshingGpu = true;
    try {
      this.value = { ...this.value, gpu: await readGpuSnapshot() };
    } finally {
      this.refreshingGpu = false;
    }
  }
}
