// Symbiote — Builtin admin tools: filesystem management and hardware inspection

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { ToolDefinition } from '../types.js';
import { expandHome, isWindows, shellCommand } from '../../runtime/platform.js';

const abs = (p: unknown): string => path.resolve(expandHome(String(p ?? '')));
const fail = (err: unknown): string => `Error: ${err instanceof Error ? err.message : String(err)}`;

// ── fs ─────────────────────────────────────────────────────────────────────

const DEFAULT_SKIP = new Set(['node_modules', '.git', '$RECYCLE.BIN', 'System Volume Information']);

function* walk(root: string, maxDepth: number, skip: boolean): Generator<{ full: string; entry: fs.Dirent }> {
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      yield { full, entry };
      if (entry.isDirectory() && depth < maxDepth && !(skip && DEFAULT_SKIP.has(entry.name))) {
        stack.push({ dir: full, depth: depth + 1 });
      }
    }
  }
}

function describe(p: string): string {
  const s = fs.lstatSync(p);
  const kind = s.isDirectory() ? 'dir' : s.isSymbolicLink() ? 'symlink' : 'file';
  return JSON.stringify({ path: p, kind, size: s.size, mode: (s.mode & 0o777).toString(8), modified: s.mtime.toISOString(), created: s.birthtime.toISOString() });
}

function moveAcrossDevices(src: string, dest: string): void {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    fs.cpSync(src, dest, { recursive: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

export const fsTool: ToolDefinition = {
  name: 'fs',
  description: 'Filesystem management across the whole machine. Actions: list, stat, mkdir, move, copy, delete, search (by file-name regex and/or file-content regex), chmod, symlink. Supports ~ paths. Use read/write/edit for file contents.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'stat', 'mkdir', 'move', 'copy', 'delete', 'search', 'chmod', 'symlink'], description: 'Operation to perform' },
      path: { type: 'string', description: 'Target path (source for move/copy; link location for symlink; root for search/list)' },
      dest: { type: 'string', description: 'Destination path for move/copy, or link target for symlink' },
      recursive: { type: 'boolean', description: 'list: recurse into subdirectories; copy/delete: recurse (default true)' },
      depth: { type: 'number', description: 'list/search: max directory depth (default 1 for list, 8 for search)' },
      name: { type: 'string', description: 'search: regex matched against file names' },
      content: { type: 'string', description: 'search: regex matched against file contents' },
      includeIgnored: { type: 'boolean', description: 'search: also descend into node_modules, .git and similar' },
      mode: { type: 'string', description: 'chmod: octal mode such as 755' },
      maxResults: { type: 'number', description: 'search/list: result cap (default 200)' },
    },
    required: ['action', 'path'],
  },
  async execute(input) {
    const action = String(input.action);
    const target = abs(input.path);
    const maxResults = Math.max(1, Number(input.maxResults ?? 200) || 200);
    try {
      switch (action) {
        case 'stat':
          return describe(target);

        case 'list': {
          const depth = input.recursive === true ? Math.max(1, Number(input.depth ?? 4) || 4) : 0;
          const rows: string[] = [];
          for (const { full, entry } of walk(target, depth, false)) {
            if (rows.length >= maxResults) { rows.push(`... capped at ${maxResults}`); break; }
            rows.push(`${entry.isDirectory() ? 'd' : '-'} ${path.relative(target, full)}${entry.isDirectory() ? path.sep : ''}`);
          }
          return rows.length ? rows.join('\n') : '(empty)';
        }

        case 'mkdir':
          fs.mkdirSync(target, { recursive: true });
          return `Created ${target}`;

        case 'move': {
          const dest = abs(input.dest);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          moveAcrossDevices(target, dest);
          return `Moved ${target} -> ${dest}`;
        }

        case 'copy': {
          const dest = abs(input.dest);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.cpSync(target, dest, { recursive: input.recursive !== false });
          return `Copied ${target} -> ${dest}`;
        }

        case 'delete':
          if (!fs.existsSync(target)) return `Error: Not found: ${target}`;
          if (path.parse(target).root === target) return 'Error: Refusing to delete a filesystem root';
          fs.rmSync(target, { recursive: input.recursive !== false, force: true });
          return `Deleted ${target}`;

        case 'chmod':
          fs.chmodSync(target, parseInt(String(input.mode ?? ''), 8));
          return `Mode of ${target} set to ${input.mode}`;

        case 'symlink': {
          const linkTarget = abs(input.dest);
          fs.symlinkSync(linkTarget, target, fs.statSync(linkTarget).isDirectory() ? 'junction' : 'file');
          return `Linked ${target} -> ${linkTarget}`;
        }

        case 'search': {
          const nameRe = input.name ? new RegExp(String(input.name), 'i') : null;
          const contentRe = input.content ? new RegExp(String(input.content), 'i') : null;
          if (!nameRe && !contentRe) return 'Error: search needs name and/or content';
          const depth = Math.max(0, Number(input.depth ?? 8) || 8);
          const hits: string[] = [];
          for (const { full, entry } of walk(target, depth, input.includeIgnored !== true)) {
            if (hits.length >= maxResults) { hits.push(`... capped at ${maxResults}`); break; }
            if (!entry.isFile()) continue;
            if (nameRe && !nameRe.test(entry.name)) continue;
            if (!contentRe) { hits.push(full); continue; }
            try {
              if (fs.statSync(full).size > 5 * 1024 * 1024) continue;
              const lines = fs.readFileSync(full, 'utf-8').split('\n');
              const idx = lines.findIndex(l => contentRe.test(l));
              if (idx >= 0) hits.push(`${full}:${idx + 1}: ${lines[idx].trim().slice(0, 160)}`);
            } catch { /* unreadable or binary */ }
          }
          return hits.length ? hits.join('\n') : 'No matches';
        }

        default:
          return `Error: Unknown action "${action}"`;
      }
    } catch (err) {
      return fail(err);
    }
  },
};

// ── hardware ───────────────────────────────────────────────────────────────

type Kind = 'summary' | 'cpu' | 'memory' | 'disks' | 'gpu' | 'network' | 'usb' | 'audio' | 'camera' | 'bluetooth' | 'displays' | 'serial' | 'battery' | 'sensors' | 'processes';

const KINDS: Kind[] = ['summary', 'cpu', 'memory', 'disks', 'gpu', 'network', 'usb', 'audio', 'camera', 'bluetooth', 'displays', 'serial', 'battery', 'sensors', 'processes'];

const pnp = (cls: string): string => `Get-PnpDevice -PresentOnly -Class ${cls} -ErrorAction SilentlyContinue | Select-Object Status,FriendlyName,InstanceId | Format-Table -AutoSize | Out-String -Width 200`;

const WINDOWS: Record<Exclude<Kind, 'summary'>, string> = {
  cpu: 'Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed,LoadPercentage | Format-List | Out-String',
  memory: 'Get-CimInstance Win32_PhysicalMemory | Select-Object BankLabel,Capacity,Speed,Manufacturer | Format-Table -AutoSize | Out-String',
  disks: 'Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,VolumeName,FileSystem,@{n="SizeGB";e={[math]::Round($_.Size/1GB,1)}},@{n="FreeGB";e={[math]::Round($_.FreeSpace/1GB,1)}} | Format-Table -AutoSize | Out-String; Get-PhysicalDisk -ErrorAction SilentlyContinue | Select-Object FriendlyName,MediaType,HealthStatus,@{n="SizeGB";e={[math]::Round($_.Size/1GB)}} | Format-Table -AutoSize | Out-String',
  gpu: 'Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,AdapterRAM,CurrentHorizontalResolution,CurrentVerticalResolution | Format-List | Out-String; if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) { nvidia-smi }',
  network: 'Get-NetAdapter -ErrorAction SilentlyContinue | Select-Object Name,Status,LinkSpeed,MacAddress | Format-Table -AutoSize | Out-String; Get-NetIPAddress -ErrorAction SilentlyContinue | Where-Object AddressState -eq Preferred | Select-Object InterfaceAlias,IPAddress | Format-Table -AutoSize | Out-String',
  usb: pnp('USB'),
  audio: `${pnp('AudioEndpoint')}; ${pnp('MEDIA')}`,
  camera: `${pnp('Camera')}; ${pnp('Image')}`,
  bluetooth: pnp('Bluetooth'),
  displays: 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens | Select-Object DeviceName,Primary,Bounds | Format-List | Out-String',
  serial: '[System.IO.Ports.SerialPort]::GetPortNames() -join "`n"',
  battery: 'Get-CimInstance Win32_Battery | Select-Object Name,EstimatedChargeRemaining,BatteryStatus,EstimatedRunTime | Format-List | Out-String',
  sensors: 'Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction SilentlyContinue | Select-Object InstanceName,@{n="TempC";e={[math]::Round($_.CurrentTemperature/10-273.15,1)}} | Format-Table -AutoSize | Out-String',
  processes: 'Get-Process | Sort-Object CPU -Descending | Select-Object -First 25 Id,ProcessName,@{n="CPU_s";e={[math]::Round($_.CPU,1)}},@{n="MemMB";e={[math]::Round($_.WorkingSet64/1MB)}} | Format-Table -AutoSize | Out-String',
};

const LINUX: Record<Exclude<Kind, 'summary'>, string> = {
  cpu: 'lscpu',
  memory: 'free -h; (dmidecode -t memory 2>/dev/null | head -40) || true',
  disks: 'lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT,MODEL; df -h --total 2>/dev/null | tail -n +1',
  gpu: '(nvidia-smi 2>/dev/null) || (lspci 2>/dev/null | grep -Ei "vga|3d|display")',
  network: 'ip -brief addr 2>/dev/null || ifconfig',
  usb: 'lsusb 2>/dev/null || ls /sys/bus/usb/devices',
  audio: '(aplay -l; arecord -l) 2>/dev/null || cat /proc/asound/cards',
  camera: 'ls -l /dev/video* 2>/dev/null; v4l2-ctl --list-devices 2>/dev/null || true',
  bluetooth: 'bluetoothctl devices 2>/dev/null || hciconfig -a 2>/dev/null || echo "no bluetooth tooling"',
  displays: 'xrandr --query 2>/dev/null || ls /sys/class/drm',
  serial: 'ls -l /dev/ttyS* /dev/ttyUSB* /dev/ttyACM* 2>/dev/null',
  battery: 'upower -i $(upower -e 2>/dev/null | grep -i bat | head -1) 2>/dev/null || cat /sys/class/power_supply/BAT*/uevent 2>/dev/null',
  sensors: 'sensors 2>/dev/null || cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null',
  processes: 'ps aux --sort=-%cpu | head -26',
};

const MAC: Record<Exclude<Kind, 'summary'>, string> = {
  cpu: 'sysctl -n machdep.cpu.brand_string; sysctl hw.ncpu hw.physicalcpu',
  memory: 'sysctl hw.memsize; vm_stat',
  disks: 'diskutil list; df -h',
  gpu: 'system_profiler SPDisplaysDataType',
  network: 'ifconfig -a | grep -E "^[a-z]|inet "',
  usb: 'system_profiler SPUSBDataType',
  audio: 'system_profiler SPAudioDataType',
  camera: 'system_profiler SPCameraDataType',
  bluetooth: 'system_profiler SPBluetoothDataType',
  displays: 'system_profiler SPDisplaysDataType',
  serial: 'ls -l /dev/tty.* /dev/cu.* 2>/dev/null',
  battery: 'pmset -g batt',
  sensors: 'pmset -g therm',
  processes: 'ps aux -r | head -26',
};

function runShell(command: string, timeoutMs = 25_000): Promise<string> {
  const sh = shellCommand(command);
  return new Promise(resolve => {
    execFile(sh.file, sh.args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = `${stdout ?? ''}${stderr ? `\n${stderr}` : ''}`.trim();
      resolve(out || (err ? `Error: ${err.message}` : '(no output)'));
    });
  });
}

function summary(): string {
  const cpus = os.cpus();
  return JSON.stringify({
    host: os.hostname(), platform: `${os.type()} ${os.release()} (${os.arch()})`, uptimeHours: Math.round(os.uptime() / 360) / 10,
    cpu: { model: cpus[0]?.model, logicalCores: cpus.length },
    memoryGB: { total: Math.round(os.totalmem() / 2 ** 30 * 10) / 10, free: Math.round(os.freemem() / 2 ** 30 * 10) / 10 },
    user: os.userInfo().username, home: os.homedir(),
  }, null, 2);
}

export const hardwareTool: ToolDefinition = {
  name: 'hardware',
  description: `Inspect the machine's hardware: ${KINDS.join(', ')}. Works on Windows, Linux and macOS. To control a device (serial write, driver or service changes, power), use exec.`,
  parameters: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: KINDS, description: 'Which hardware area to inspect (default summary)' },
    },
  },
  async execute(input) {
    const kind = String(input.kind ?? 'summary') as Kind;
    if (!KINDS.includes(kind)) return `Error: Unknown kind "${kind}". Use one of: ${KINDS.join(', ')}`;
    if (kind === 'summary') return summary();
    const table = isWindows() ? WINDOWS : process.platform === 'darwin' ? MAC : LINUX;
    return runShell(table[kind]);
  },
};

export const adminTools: ToolDefinition[] = [fsTool, hardwareTool];
