import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  heartbeatTaskKey,
  parseAuthorizedHeartbeatTasks,
  parseHeartbeatDecision,
  pauseHeartbeatAutomation,
  readAvailableHeartbeatTasks,
  recordHeartbeatTask,
  selectHeartbeatTask,
} from '../heartbeat/automation.js';
import { HeartbeatScheduler } from '../heartbeat/scheduler.js';

function temporaryWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-heartbeat-'));
}

test('heartbeat only recognizes unchecked tasks in the explicit Authorized Tasks section', () => {
  assert.deepEqual(parseAuthorizedHeartbeatTasks([
    '# HEARTBEAT.md',
    '- [ ] Ignore this task outside the authorized section.',
    '## Authorized Tasks',
    '<!--',
    '- [ ] Ignore commented task examples.',
    '-->',
    '```markdown',
    '- [ ] Ignore fenced task examples.',
    '```',
    '- [ ] Inspect the configured workspace health.',
    '- [x] This task is already complete.',
    '## Notes',
    '- [ ] Ignore tasks outside the authorized section.',
  ].join('\n')), ['Inspect the configured workspace health.']);
  assert.deepEqual(parseAuthorizedHeartbeatTasks('# No authorized tasks'), []);
});

test('heartbeat task parsing resumes after an indented closing code fence', () => {
  assert.deepEqual(parseAuthorizedHeartbeatTasks([
    '```markdown',
    '## Authorized Tasks',
    '- [ ] Ignore this fenced example.',
    '  ```',
    '## Authorized Tasks',
    '- [ ] Inspect the configured workspace health.',
  ].join('\n')), ['Inspect the configured workspace health.']);
});

test('heartbeat deterministically selects the first available exact task', () => {
  assert.equal(selectHeartbeatTask(['Inspect disk.', 'Check n8n.']), 'Inspect disk.');
  assert.equal(selectHeartbeatTask([]), null);
});

test('heartbeat decision must select an exact authorized task or idle', () => {
  const tasks = ['Inspect one scoped item.'];
  assert.deepEqual(parseHeartbeatDecision('{"action":"idle"}', tasks), { action: 'idle' });
  assert.deepEqual(
    parseHeartbeatDecision('{"action":"execute","task":"Inspect one scoped item."}', tasks),
    { action: 'execute', task: tasks[0] },
  );
  assert.throws(() => parseHeartbeatDecision('{"action":"execute","task":"Do unrelated work."}', tasks), /exact authorized task/);
  assert.throws(() => parseHeartbeatDecision('{"action":"execute","task":"Inspect one scoped item.","reason":"..."}', tasks), /exact authorized task/);
  assert.throws(() => parseHeartbeatDecision('not json', tasks), /valid JSON/);
});

test('heartbeat task attempts persist and are not automatically replayed', () => {
  const workspace = temporaryWorkspace();
  try {
    const task = 'Inspect one scoped item.';
    fs.writeFileSync(path.join(workspace, 'HEARTBEAT.md'), `## Authorized Tasks\n- [ ] ${task}\n`);
    assert.deepEqual(readAvailableHeartbeatTasks(workspace), [task]);
    recordHeartbeatTask(workspace, task, 'started');
    assert.deepEqual(readAvailableHeartbeatTasks(workspace), []);
    recordHeartbeatTask(workspace, task, 'failed', 'temporary failure');
    assert.deepEqual(readAvailableHeartbeatTasks(workspace), []);
    assert.equal(heartbeatTaskKey(task).length, 64);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('automation scope changes block further heartbeat work until the scope is edited again', () => {
  const workspace = temporaryWorkspace();
  try {
    const initial = '## Authorized Tasks\n- [ ] Inspect one scoped item.\n';
    fs.writeFileSync(path.join(workspace, 'HEARTBEAT.md'), initial);
    assert.equal(readAvailableHeartbeatTasks(workspace).length, 1);
    fs.writeFileSync(path.join(workspace, 'HEARTBEAT.md'), `${initial}\nChanged during execution.\n`);
    pauseHeartbeatAutomation(workspace);
    assert.deepEqual(readAvailableHeartbeatTasks(workspace), []);
    fs.writeFileSync(path.join(workspace, 'HEARTBEAT.md'), `${initial}\nReviewed by the owner.\n`);
    assert.deepEqual(readAvailableHeartbeatTasks(workspace), ['Inspect one scoped item.']);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('heartbeat scheduler refuses to run without explicit work and start is idempotent', () => {
  const scheduler = new HeartbeatScheduler({
    hasWork: () => true,
    quietHoursStart: 0,
    quietHoursEnd: 24,
  });
  assert.equal(scheduler.shouldFire(), false);
  scheduler.start(async () => undefined);
  scheduler.start(async () => { throw new Error('second callback must not replace the first'); });
  assert.equal(scheduler.shouldFire(), false);
  scheduler.stop();
  assert.equal(scheduler.status().running, false);
});

test('heartbeat scheduler requires an explicit hasWork signal', () => {
  const scheduler = new HeartbeatScheduler({
    quietHoursStart: 0,
    quietHoursEnd: 24,
  });
  scheduler.start(async () => undefined);
  assert.equal(scheduler.shouldFire(), false);
  scheduler.stop();
});
