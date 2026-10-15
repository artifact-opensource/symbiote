import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateCpuPercent, parseProcDiskStats, parseProcNetwork } from '../metrics/system-resources.js';

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
