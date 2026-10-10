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

test('POSIX-style commands work whichever shell the host defaults to', async () => {
  const chained = String(await execTool.execute({ command: 'echo one && echo two' }));
  assert.match(chained, /one/);
  assert.match(chained, /two/);
  const piped = String(await execTool.execute({ command: 'echo alpha beta | head -n 1' }));
  assert.match(piped, /alpha beta/);
});

test('PowerShell syntax still works on Windows and a shell can be forced', async () => {
  if (process.platform !== 'win32') return;
  assert.match(String(await execTool.execute({ command: 'Write-Output ps-ok' })), /ps-ok/);
  assert.match(String(await execTool.execute({ command: 'Write-Output forced', shell: 'powershell' })), /forced/);
});

test('failed commands carry a hint that exec itself is healthy', async () => {
  if (process.platform !== 'win32') return;
  const out = String(await execTool.execute({ command: 'Get-DefinitelyNotACommand', shell: 'powershell' }));
  assert.match(out, /exec is working/);
});
