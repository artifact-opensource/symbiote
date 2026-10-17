import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execTool } from '../tools/builtin/exec.js';
import { ProcessManager } from '../tools/builtin/process.js';
import { classifySession, configureSandbox, createSandboxedRegistry } from '../tools/sandbox.js';
import { hintForFailure } from '../runtime/platform.js';

test('exec runs a shell command on this host', async () => {
  const out = await execTool.execute({ command: 'echo symbiote-ok' });
  assert.match(String(out), /symbiote-ok/);
});

test('exec reports successful commands that intentionally produce no output', async () => {
  const out = await execTool.execute({ command: 'node -e "process.exit(0)"' });
  assert.equal(out, 'Command completed successfully (exit code 0; no output).');
});

test('exec does not block commands that mention the project name', async () => {
  const out = await execTool.execute({ command: 'echo restart symbiote' });
  assert.doesNotMatch(String(out), /Cannot restart\/kill/);
});

test('sandbox defaults to configured tiers and grants admin access only to owners', () => {
  configureSandbox(undefined);
  const context = {
    sessionId: 's', adapterId: 'discord-main', channelType: 'discord', chatType: 'group' as const,
    senderId: 'x', isOwner: false,
  };
  assert.equal(classifySession(context), 'restricted');
  assert.equal(classifySession({ ...context, isOwner: true }), 'admin');
  assert.equal(classifySession({ ...context, adapterId: 'subagent', channelType: 'internal' }), 'standard');
});

test('sandbox config can tighten owner and internal-session access', () => {
  configureSandbox({ enabled: true, ownerAccess: false, internalTier: 'restricted', nonOwnerTier: 'restricted' });
  const context = {
    sessionId: 's', adapterId: 'discord-main', channelType: 'discord', chatType: 'direct' as const,
    senderId: 'owner', isOwner: true,
  };
  assert.equal(classifySession(context), 'restricted');
  assert.equal(classifySession({ ...context, adapterId: 'subagent', channelType: 'internal' }), 'restricted');
  configureSandbox(undefined);
});

test('project sandbox defaults shell workdir to the workspace and rejects outside paths', async () => {
  configureSandbox(undefined);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-project-sandbox-'));
  const outside = path.dirname(root);
  const context = {
    sessionId: 'project-session',
    adapterId: 'project-ide',
    channelType: 'internal',
    chatType: 'direct' as const,
    senderId: 'webapp-user',
    isOwner: false,
    workspaceRoot: root,
  };
  let executedWorkdir = '';
  const inner = {
    list: () => [],
    toProviderFormat: () => [],
    execute: async (_name: string, input: Record<string, unknown>) => {
      executedWorkdir = String(input.workdir);
      return 'ok';
    },
  };
  try {
    const sandbox = createSandboxedRegistry(inner, context);
    assert.equal(await sandbox.execute('exec', { command: 'git status' }), 'ok');
    assert.equal(executedWorkdir, root);
    const denied = JSON.parse(await sandbox.execute('exec', { command: 'git status', workdir: outside })) as { sandbox: boolean };
    assert.equal(denied.sandbox, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    configureSandbox(undefined);
  }
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

test('Git Bash Windows-path errors explain how to use exec correctly', () => {
  if (process.platform !== 'win32') return;
  const out = hintForFailure(
    'cd C:\\workspace\\symbiote; npm test',
    '/usr/bin/bash: line 1: cd: C:workspacesymbiote: No such file or directory',
  );
  assert.match(out, /exec is working/);
  assert.match(out, /Omit cd and pass workdir/);
  assert.match(out, /\/c\/workspace\/symbiote/);

  const guessedPosixPath = hintForFailure(
    'cd /workspace/symbiote',
    '/usr/bin/bash: line 1: cd: /workspace/symbiote: No such file or directory',
  );
  assert.match(guessedPosixPath, /configured working directory/);
  assert.match(guessedPosixPath, /\/workspace or \/tmp/);
});

test('background process spawn failures are reported as completed failures', async () => {
  const manager = new ProcessManager();
  const missingWorkdir = `${process.env.TEMP ?? process.cwd()}\\symbiote-missing-${Date.now()}`;
  const proc = manager.start('echo should-not-run', missingWorkdir);
  await new Promise<void>(resolve => proc.proc.once('close', () => resolve()));

  const result = manager.poll(proc.id);
  assert.ok(result);
  assert.equal(result.running, false);
  assert.notEqual(result.exitCode, null);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.output, /Error:/);
});
