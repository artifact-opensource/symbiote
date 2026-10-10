import test from 'node:test';
import assert from 'node:assert/strict';
import { execTool } from '../tools/builtin/exec.js';
import { classifySession } from '../tools/sandbox.js';

test('exec runs a shell command on this host', async () => {
  const out = await execTool.execute({ command: 'echo symbiote-ok' });
  assert.match(String(out), /symbiote-ok/);
});

test('exec does not block commands that mention the project name', async () => {
  const out = await execTool.execute({ command: 'echo restart symbiote' });
  assert.doesNotMatch(String(out), /Cannot restart\/kill/);
});

test('sandbox grants full access by default', () => {
  const tier = classifySession({
    sessionId: 's', adapterId: 'discord-main', channelType: 'discord', chatType: 'group',
    senderId: 'x', isOwner: false,
  });
  assert.equal(tier, 'admin');
});
