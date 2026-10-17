import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateCpuCorePercents,
  calculateCpuPercent,
  parseNvidiaGpuCounters,
  parseProcDiskStats,
  parseProcNetwork,
  parseWindowsGpuCounters,
  parseWindowsThermalCounter,
} from '../metrics/system-resources.js';

test('host CPU utilization is normalized by aggregate core time and bounded', () => {
  const previous = [
    { user: 10, nice: 0, sys: 5, idle: 85, irq: 0 },
    { user: 10, nice: 0, sys: 5, idle: 85, irq: 0 },
  ];
  const current = [
    { user: 25, nice: 0, sys: 10, idle: 165, irq: 0 },
    { user: 35, nice: 0, sys: 10, idle: 155, irq: 0 },
  ];

  assert.equal(calculateCpuPercent(previous, current), 25);
  assert.deepEqual(calculateCpuCorePercents(previous, current), [20, 30]);
  assert.deepEqual(calculateCpuCorePercents([], current), [null, null]);
  assert.equal(calculateCpuPercent([], current), null);
  assert.equal(calculateCpuPercent(previous, previous), null);
});

test('Linux network counters sum non-loopback received and transmitted bytes', () => {
  const sample = [
    'Inter-| Receive | Transmit',
    ' face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed',
    '    lo: 900 1 0 0 0 0 0 0 900 1 0 0 0 0 0 0',
    '  eth0: 1000 2 0 0 0 0 0 0 4000 3 0 0 0 0 0 0',
    ' wlan0: 2000 4 0 0 0 0 0 0 8000 6 0 0 0 0 0 0',
  ].join('\n');

  assert.deepEqual(parseProcNetwork(sample), { received: 3000, sent: 12000 });
});

test('Linux disk I/O aggregates whole disks and excludes partitions', () => {
  const sample = [
    '8 0 sda 1 0 100 0 2 0 200 0 0 0 0',
    '8 1 sda1 3 0 300 0 4 0 400 0 0 0 0',
    '259 0 nvme0n1 5 0 500 0 6 0 600 0 0 0 0',
  ].join('\n');

  assert.deepEqual(parseProcDiskStats(sample), { readBytes: 600 * 512, writtenBytes: 800 * 512 });
});

test('Windows high-precision thermal counters convert hundredths of Celsius and discard invalid readings', () => {
  const readings = parseWindowsThermalCounter(JSON.stringify([
    { name: '\\_SB._SAN.TZ01', value: 3226 },
    { name: '\\_SB._SAN.TZ02', value: 3157 },
    { name: '\\_SB._SAN.TZ03', value: 99999 },
  ]));

  assert.deepEqual(readings, [
    { name: 'Thermal zone 01', celsius: 32.3, source: 'Windows ACPI thermal-zone performance counter' },
    { name: 'Thermal zone 02', celsius: 31.6, source: 'Windows ACPI thermal-zone performance counter' },
  ]);
});

test('NVIDIA GPU counters aggregate memory and report the busiest adapter load', () => {
  const gpu = parseNvidiaGpuCounters([
    'NVIDIA RTX A, 42, 1024, 8192',
    'NVIDIA RTX B, 73, 2048, 16384',
  ].join('\n'));

  assert.equal(gpu.state, 'available');
  assert.deepEqual(gpu.devices.map(device => device.name), ['NVIDIA RTX A', 'NVIDIA RTX B']);
  assert.equal(gpu.loadPercent, 73);
  assert.equal(gpu.dedicatedMemoryUsedBytes, 3072 * 1024 * 1024);
  assert.equal(gpu.dedicatedMemoryTotalBytes, 24_576 * 1024 * 1024);
});

test('Windows GPU counters aggregate processes by engine and expose adapter memory', () => {
  const gpu = parseWindowsGpuCounters(JSON.stringify({
    adapters: [{ name: 'Intel Iris Graphics', dedicatedTotalBytes: 1_073_741_824 }],
    engines: [
      { name: 'pid_10_luid_0x0_0xf183_phys_0_eng_0_engtype_3d', value: 22 },
      { name: 'pid_11_luid_0x0_0xf183_phys_0_eng_0_engtype_3d', value: 18 },
      { name: 'pid_10_luid_0x0_0xf183_phys_0_eng_1_engtype_copy', value: 12 },
    ],
    memory: [
      { name: 'luid_0x0_0xf183_phys_0', counter: 'Dedicated Usage', value: 64 * 1024 * 1024 },
      { name: 'luid_0x0_0xf183_phys_0', counter: 'Shared Usage', value: 512 * 1024 * 1024 },
    ],
  }));

  assert.equal(gpu.state, 'available');
  assert.deepEqual(gpu.devices.map(device => device.name), ['Intel Iris Graphics']);
  assert.equal(gpu.loadPercent, 40);
  assert.equal(gpu.dedicatedMemoryUsedBytes, 64 * 1024 * 1024);
  assert.equal(gpu.dedicatedMemoryTotalBytes, 1_073_741_824);
  assert.equal(gpu.sharedMemoryUsedBytes, 512 * 1024 * 1024);
});

test('Windows GPU counters report zero load when the detected adapter is idle', () => {
  const gpu = parseWindowsGpuCounters(JSON.stringify({
    adapters: [{ name: 'Intel Iris Graphics', dedicatedTotalBytes: 1_073_741_824 }],
    engines: [],
    memory: [],
    engineCountersAvailable: true,
  }));

  assert.equal(gpu.state, 'available');
  assert.equal(gpu.loadPercent, 0);
  assert.equal(gpu.unavailableReason, undefined);
});

test('GPU detection reports unavailable when Windows exposes no physical adapter', () => {
  const gpu = parseWindowsGpuCounters(JSON.stringify({
    adapters: [{ name: 'Microsoft Basic Render Driver', dedicatedTotalBytes: 0 }],
    engines: [],
    memory: [],
  }));
  assert.equal(gpu.state, 'unavailable');
  assert.match(gpu.unavailableReason ?? '', /No GPU adapter/);
});
