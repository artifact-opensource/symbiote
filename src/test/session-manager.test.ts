import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from '../sessions/manager.js';

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
