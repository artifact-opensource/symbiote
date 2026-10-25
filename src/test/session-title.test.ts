import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from '../sessions/manager.js';
import { deriveConversationTitle } from '../sessions/title.js';
import { stripBlinkControlMessages } from '../agent/blink.js';

test('runtime continuation and completion-review prompts are not user history', () => {
  const messages = [
    { role: 'user', content: '⚡ BLINK APPROACHING — internal continuation state' },
    { role: 'user', content: 'Internal completion review: compare work and continue if needed.' },
    { role: 'user', content: 'A normal user prompt.' },
    { role: 'system', content: 'Internal completion review: compare work and continue if needed.' },
    { role: 'system', content: 'Checklist verification found unfinished tasks: keep working.' },
    { role: 'system', content: 'The real system prompt remains.' },
  ];
  assert.deepEqual(stripBlinkControlMessages(messages), [messages[2], messages[5]]);
});

test('completion-review drafts are removed from persisted history without removing tool calls', () => {
  const draft = { role: 'assistant', content: 'Unverified draft response.' };
  const review = { role: 'system', content: 'Internal completion review: verify the work.' };
  const toolCall = { role: 'assistant', content: '', tool_calls: [{ id: 'read-1', name: 'read' }] };
  assert.deepEqual(stripBlinkControlMessages([draft, review]), []);
  assert.deepEqual(stripBlinkControlMessages([toolCall, review]), [toolCall]);
});

test('conversation title is derived from the first two user prompts only', () => {
  const messages = [
    { role: 'user', content: 'Review the activity log and find the regression.' },
    { role: 'assistant', content: 'I will inspect it.' },
    { role: 'user', content: 'Then fix the streaming tool status display.' },
    { role: 'user', content: 'Also rename unrelated components.' },
  ] as const;

  assert.equal(deriveConversationTitle(messages.slice(0, 1)), undefined);
  assert.equal(
    deriveConversationTitle(messages),
    'Review the activity log… · Then fix the streaming tool…',
  );
});

test('session title is saved after the second user prompt and sanitized', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-session-title-'));
  try {
    const manager = new SessionManager(directory);
    const session = manager.create('web-title-test', { label: 'New conversation' });
    session.messages.push({ role: 'user', content: 'Summarize this workspace and inspect apiKey=private-value.' });
    manager.save(session);
    assert.equal(manager.load(session.id)?.metadata.label, 'New conversation');

    session.messages.push({ role: 'user', content: 'Improve chat streaming.' });
    manager.save(session);
    assert.equal(manager.load(session.id)?.metadata.label, 'Summarize this workspace… · Improve chat streaming');
    assert.doesNotMatch(session.metadata.label ?? '', /private-value/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
