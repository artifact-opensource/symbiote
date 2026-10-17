import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CronManager, nextCronOccurrence, type CronAlert } from '../cron/manager.js';

function localDate(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number {
  return new Date(year, month - 1, day, hour, minute, second, 0).getTime();
}

function temporaryWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-cron-'));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for cron alert processing.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('cron parser calculates minute, weekday, Sunday alias, and day-of-month OR day-of-week matches', () => {
  assert.equal(
    nextCronOccurrence('*/15 * * * *', localDate(2025, 1, 1, 10, 7, 32)),
    localDate(2025, 1, 1, 10, 15),
  );
  assert.equal(
    nextCronOccurrence('0 9 1 * 1', localDate(2025, 6, 2, 9, 1)),
    localDate(2025, 6, 9, 9),
  );
  assert.equal(
    nextCronOccurrence('0 0 * * 7', localDate(2025, 1, 5, 0, 1)),
    localDate(2025, 1, 12),
  );
  assert.throws(() => nextCronOccurrence('0 25 * * *'), /hour values/);
  assert.throws(() => nextCronOccurrence('0 0 * *'), /five fields/);
  assert.throws(() => nextCronOccurrence('1,,2 * * * *'), /empty list item/);
});

test('cron jobs persist and can be paused, resumed, updated, and deleted', () => {
  const workspace = temporaryWorkspace();
  try {
    const manager = new CronManager(workspace);
    const created = manager.createJob({
      name: 'Weekday review',
      prompt: 'Check the current queue and report blocked tasks.',
      schedule: { type: 'cron', expression: '0 9 * * 1-5' },
    });
    assert.equal(created.enabled, true);

    const restored = new CronManager(workspace);
    assert.equal(restored.listJobs()[0].id, created.id);
    assert.equal(restored.getDefaultAgentPrompt().includes('authorized work end to end'), true);
    assert.throws(() => restored.createJob({
      name: 'Invalid schedule',
      prompt: 'Do not run.',
      schedule: { type: 'cron', expression: 'noon' },
    }), /five fields/);
    assert.throws(() => restored.createJob({
      name: 'Too soon',
      prompt: 'Do not run.',
      schedule: { type: 'once', runAt: Date.now() + 1_000 },
    }), /at least 30 seconds/);

    const paused = restored.updateJob(created.id, { enabled: false, name: 'Paused review' });
    assert.equal(paused.enabled, false);
    assert.equal(paused.name, 'Paused review');
    assert.equal(restored.updateJob(created.id, { enabled: true }).enabled, true);
    assert.equal(restored.deleteJob(created.id), true);
    assert.equal(restored.deleteJob(created.id), false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('due reminders persist as alerts, recover interrupted work, and can be retried', async () => {
  const workspace = temporaryWorkspace();
  const manager = new CronManager(workspace);
  try {
    const job = manager.createJob({
      name: 'Verify output',
      prompt: 'Inspect the generated output and report the result.',
      schedule: { type: 'once', runAt: Date.now() + 60_000 },
    });
    const jobsPath = path.join(workspace, '.agents', 'cron', 'jobs.json');
    const jobsFile = JSON.parse(fs.readFileSync(jobsPath, 'utf8')) as { jobs: Array<{ id: string; nextRunAt: number }> };
    jobsFile.jobs.find(item => item.id === job.id)!.nextRunAt = Date.now() - 1;
    fs.writeFileSync(jobsPath, JSON.stringify(jobsFile));

    manager.updateDefaultAgentPrompt('Dedicated operations instructions.');
    const defaultPath = path.join(workspace, '.agents', 'default.json');
    const defaultFile = JSON.parse(fs.readFileSync(defaultPath, 'utf8')) as { alerts: CronAlert[] };
    defaultFile.alerts.push({
      id: 'previously-running',
      jobId: job.id,
      jobName: job.name,
      prompt: job.prompt,
      scheduledAt: Date.now() - 1_000,
      createdAt: Date.now() - 1_000,
      status: 'running',
      attempts: 1,
    });
    fs.writeFileSync(defaultPath, JSON.stringify(defaultFile));

    let attempts = 0;
    manager.start(async () => {
      attempts++;
      if (attempts === 1) throw new Error('temporary provider failure');
    });
    await waitFor(() => manager.listAlerts().some(alert => alert.status === 'failed'));
    const failedAlert = manager.listAlerts().find(alert => alert.status === 'failed')!;
    assert.equal(failedAlert.lastError, 'temporary provider failure');

    manager.retryAlert(failedAlert.id);
    await waitFor(() => manager.listAlerts().find(alert => alert.id === failedAlert.id)?.status === 'completed');
    assert.equal(attempts, 3);
    assert.equal(manager.listAlerts().find(alert => alert.id === 'previously-running')?.status, 'completed');
    assert.equal(manager.listJobs().find(item => item.id === job.id)?.enabled, false);
  } finally {
    manager.stop();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
