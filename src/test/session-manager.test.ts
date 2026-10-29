import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager, SessionPersistenceError } from '../sessions/manager.js';

test('hidden and heartbeat sessions stay out of normal session listings', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-session-list-'));
  try {
    const manager = new SessionManager(directory);
    manager.create('ordinary-conversation', { label: 'Ordinary conversation', sessionKind: 'conversation' });
    const gamma = manager.create('heartbeat-gamma', { label: 'Gamma heartbeat', sessionKind: 'conversation', hiddenFromList: true });
    manager.create('heartbeat-old-task', { label: 'Old heartbeat', sessionKind: 'conversation' });
    gamma.messages = [{ role: 'user', content: 'Authorized heartbeat task' }];
    manager.save(gamma);

    assert.equal(manager.load('heartbeat-gamma')?.metadata.label, 'Gamma heartbeat');
    assert.deepEqual(manager.list().map(session => session.id), ['ordinary-conversation']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('archiving keeps assistant tool calls with all their results', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-session-archive-'));
  try {
    const manager = new SessionManager(directory);
    const session = manager.create('archive-test');
    session.messages = [
      { role: 'user', content: 'Older conversation' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call-a', name: 'read', input: { path: 'a.txt' } },
          { id: 'call-b', name: 'read', input: { path: 'b.txt' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call-a', content: 'A' },
      { role: 'tool', tool_call_id: 'call-b', content: 'B' },
      { role: 'user', content: 'Newer conversation' },
    ];
    manager.save(session);

    assert.equal(manager.archive(session.id, 2), 1);

    const active = manager.load(session.id)!;
    const archiveFile = fs.readdirSync(path.join(directory, 'archive'))[0];
    const archived = JSON.parse(fs.readFileSync(path.join(directory, 'archive', archiveFile), 'utf8'));
    assert.equal(active.messages[0].role, 'assistant');
    assert.deepEqual(
      active.messages.filter(message => message.role === 'tool').map(message => message.tool_call_id),
      ['call-a', 'call-b'],
    );
    assert.equal(archived.messages.some((message: { role: string }) => message.role === 'assistant'), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('loading an orphaned tool result persists cleanup once', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-session-cleanup-'));
  try {
    const manager = new SessionManager(directory);
    const session = manager.create('cleanup-test');
    session.messages = [
      { role: 'user', content: 'Request' },
      { role: 'tool', tool_call_id: 'missing-call', content: 'stale result' },
      { role: 'assistant', content: 'Response' },
    ];
    manager.save(session);

    const loaded = manager.load(session.id)!;
    assert.deepEqual(loaded.messages.map(message => message.role), ['user', 'assistant']);
    const saved = JSON.parse(fs.readFileSync(path.join(directory, 'cleanup-test.json'), 'utf8'));
    assert.deepEqual(saved.messages.map((message: { role: string }) => message.role), ['user', 'assistant']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('session save retries Windows rename locks with a real delay', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-session-rename-'));
  const rename = fs.renameSync;
  try {
    const manager = new SessionManager(directory);
    const session = manager.create('rename-retry');
    let attempts = 0;
    fs.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
      attempts++;
      if (attempts === 1) {
        const error = Object.assign(new Error('File is locked.'), { code: 'EPERM' });
        throw error;
      }
      return rename(oldPath, newPath);
    }) as typeof fs.renameSync;

    const startedAt = Date.now();
    manager.save(session);

    assert.equal(attempts, 2);
    assert.ok(Date.now() - startedAt >= 20);
    assert.ok(fs.existsSync(path.join(directory, 'rename-retry.json')));
  } finally {
    fs.renameSync = rename;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('session saves use unique temporary files for the same destination', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-session-unique-temp-'));
  const rename = fs.renameSync;
  const temporaryPaths: string[] = [];
  try {
    const manager = new SessionManager(directory);
    const session = manager.create('unique-temp');
    fs.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
      temporaryPaths.push(String(oldPath));
      return rename(oldPath, newPath);
    }) as typeof fs.renameSync;

    manager.save(session);
    manager.save(session);

    assert.equal(temporaryPaths.length, 2);
    assert.notEqual(temporaryPaths[0], temporaryPaths[1]);
    assert.ok(temporaryPaths.every(file => file.endsWith('.tmp')));
    assert.ok(fs.existsSync(path.join(directory, 'unique-temp.json')));
  } finally {
    fs.renameSync = rename;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('session save does not retry an ENOENT rename and logs persistence failure', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-session-enoent-'));
  const rename = fs.renameSync;
  const originalConsoleError = console.error;
  const logs: string[] = [];
  try {
    const manager = new SessionManager(directory);
    const session = manager.create('rename-enoent');
    let attempts = 0;
    fs.renameSync = (() => {
      attempts++;
      throw Object.assign(new Error('source file was already moved'), { code: 'ENOENT' });
    }) as typeof fs.renameSync;
    console.error = (...args: unknown[]) => logs.push(args.map(String).join(' '));

    assert.throws(() => manager.save(session), SessionPersistenceError);
    assert.equal(attempts, 1);
    assert.ok(logs.some(line => line.includes('Failed to persist session rename-enoent')));
    assert.deepEqual(fs.readdirSync(directory), ['rename-enoent.json']);
  } finally {
    fs.renameSync = rename;
    console.error = originalConsoleError;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('channel routes survive session-manager restarts and remain adapter-scoped', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-session-routes-'));
  try {
    const first = new SessionManager(directory);
    first.saveRoute({
      channelType: 'discord',
      adapterId: 'discord-main',
      chatId: 'room-1',
      sessionId: 'session-a',
      lastActive: 100,
    });
    first.saveRoute({
      channelType: 'discord',
      adapterId: 'discord-secondary',
      chatId: 'room-1',
      sessionId: 'session-b',
      lastActive: 200,
    });

    const restored = new SessionManager(directory).loadRoutes();
    assert.equal(restored.length, 2);
    assert.equal(restored.find(route => route.adapterId === 'discord-main')?.sessionId, 'session-a');
    assert.equal(restored.find(route => route.adapterId === 'discord-secondary')?.sessionId, 'session-b');

    first.saveRoute({
      channelType: 'discord',
      adapterId: 'discord-main',
      chatId: 'room-1',
      sessionId: 'session-a',
      lastActive: 300,
    });
    assert.equal(new SessionManager(directory).loadRoutes().length, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
