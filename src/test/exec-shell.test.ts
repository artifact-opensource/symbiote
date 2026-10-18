import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_EXEC_TIMEOUT_SECONDS, execTool, resolveExecTimeoutMs } from '../tools/builtin/exec.js';
import { resolveToolTimeoutMs } from '../agent/runner.js';
import { ProcessManager } from '../tools/builtin/process.js';
import { classifySession, configureSandbox, createSandboxedRegistry } from '../tools/sandbox.js';
import { hintForFailure } from '../runtime/platform.js';

test('exec defaults to a five-second timeout and accepts explicit longer timeouts', () => {
  assert.equal(DEFAULT_EXEC_TIMEOUT_SECONDS, 5);
  assert.equal(resolveExecTimeoutMs(undefined), 5000);
  assert.equal(resolveExecTimeoutMs(60), 60_000);
  assert.throws(() => resolveExecTimeoutMs(0), /positive number/);
  assert.throws(() => resolveExecTimeoutMs(Number.NaN), /positive number/);
});

test('runner applies the intended hard timeout to exec and other routed tools', () => {
  const previous = process.env.SYMBIOTE_TOOL_TIMEOUT_MS;
  delete process.env.SYMBIOTE_TOOL_TIMEOUT_MS;
  try {
    assert.equal(resolveToolTimeoutMs('exec'), 5_000);
    assert.equal(resolveToolTimeoutMs('exec', { timeout: 45 }), 45_000);
    assert.equal(resolveToolTimeoutMs('read'), 5_000);
    assert.equal(resolveToolTimeoutMs('web_fetch'), 15_000);
    assert.equal(resolveToolTimeoutMs('memory_search'), 10_000);
    assert.equal(resolveToolTimeoutMs('unmapped_test_tool'), 15 * 60_000);
    process.env.SYMBIOTE_TOOL_TIMEOUT_MS = '1234';
    assert.equal(resolveToolTimeoutMs('exec', { timeout: 45 }), 1_234);
  } finally {
    if (previous === undefined) delete process.env.SYMBIOTE_TOOL_TIMEOUT_MS;
    else process.env.SYMBIOTE_TOOL_TIMEOUT_MS = previous;
  }
});

test('exec runs a shell command on this host', async () => {
  const out = await execTool.execute({ command: 'echo symbiote-ok', timeout: 30 });
  assert.match(String(out), /symbiote-ok/);
});

test('exec reports successful commands that intentionally produce no output', async () => {
  const out = await execTool.execute({ command: 'node -e "process.exit(0)"', timeout: 30 });
  assert.equal(out, 'Command completed successfully (exit code 0; no output).');
});

test('exec does not block commands that mention the project name', async () => {
  const out = await execTool.execute({ command: 'echo restart symbiote', timeout: 30 });
  assert.doesNotMatch(String(out), /Cannot restart\/kill/);
});

test('sandbox defaults to full trusted-owner/internal access while keeping external nonowners restricted', () => {
  configureSandbox(undefined);
  const context = {
    sessionId: 's', adapterId: 'discord-main', channelType: 'discord', chatType: 'group' as const,
    senderId: 'x', isOwner: false,
  };
  assert.equal(classifySession(context), 'restricted');
  assert.equal(classifySession({ ...context, isOwner: true }), 'admin');
  assert.equal(classifySession({ ...context, adapterId: 'subagent', channelType: 'internal' }), 'admin');
  assert.equal(classifySession({ ...context, adapterId: 'subagent', channelType: 'internal', inheritedTier: 'admin' }), 'admin');
  assert.equal(classifySession({ ...context, adapterId: 'subagent', channelType: 'internal', inheritedTier: 'restricted' }), 'restricted');
  assert.equal(classifySession({ ...context, adapterId: 'project-ide-task', channelType: 'internal', isOwner: true }), 'admin');
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
  configureSandbox({ enabled: true });
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
  let executedSessionId = '';
  const inner = {
    list: () => [],
    toProviderFormat: () => [],
    execute: async (_name: string, input: Record<string, unknown>, options?: { sessionId?: string }) => {
      executedWorkdir = String(input.workdir);
      executedSessionId = options?.sessionId ?? '';
      return 'ok';
    },
  };
  try {
    const sandbox = createSandboxedRegistry(inner, context);
    assert.equal(await sandbox.execute('exec', { command: 'git status' }), 'ok');
    assert.equal(executedWorkdir, root);
    assert.equal(executedSessionId, context.sessionId);
    const denied = JSON.parse(await sandbox.execute('exec', { command: 'git status', workdir: outside })) as { sandbox: boolean };
    assert.equal(denied.sandbox, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    configureSandbox(undefined);
  }
});

test('background shell processes are private to the session that launched them', () => {
  const manager = new ProcessManager();
  const process = manager.start('echo owned-session-output', undefined, 'agent-a');
  try {
    assert.equal(manager.poll(process.id, 'agent-b'), null);
    assert.equal(manager.list('agent-b').some(item => item.id === process.id), false);
    assert.equal(manager.list('agent-a').some(item => item.id === process.id), true);
    assert.equal(manager.kill(process.id, 'agent-b'), false);
    assert.equal(manager.kill(process.id, 'agent-a'), true);
  } finally {
    manager.kill(process.id, 'agent-a');
  }
});

test('POSIX-style commands work whichever shell the host defaults to', async () => {
  const chained = String(await execTool.execute({ command: 'echo one && echo two', timeout: 30 }));
  assert.match(chained, /one/);
  assert.match(chained, /two/);
  const piped = String(await execTool.execute({ command: 'echo alpha beta | head -n 1', timeout: 30 }));
  assert.match(piped, /alpha beta/);
});

test('PowerShell syntax still works on Windows and a shell can be forced', async () => {
  if (process.platform !== 'win32') return;
  assert.match(String(await execTool.execute({ command: 'Write-Output ps-ok', timeout: 30 })), /ps-ok/);
  assert.match(String(await execTool.execute({ command: 'Write-Output forced', shell: 'powershell', timeout: 30 })), /forced/);
});

test('failed commands carry a hint that exec itself is healthy', async () => {
  if (process.platform !== 'win32') return;
  const out = String(await execTool.execute({ command: 'Get-DefinitelyNotACommand', shell: 'powershell', timeout: 30 }));
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
