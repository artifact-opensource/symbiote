import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { DEFAULT_EXEC_TIMEOUT_SECONDS, execTool, resolveExecTimeoutMs } from '../tools/builtin/exec.js';
import { resolveToolTimeoutMs } from '../agent/runner.js';
import { ProcessManager } from '../tools/builtin/process.js';
import { classifySession, configureSandbox, createSandboxedRegistry } from '../tools/sandbox.js';
import { hintForFailure, isExecutableAvailable } from '../runtime/platform.js';
import { guardOutputStream } from '../runtime/process-stdio.js';

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

test('exec reports a missing working directory before spawning', async () => {
  const missingWorkdir = path.join(os.tmpdir(), `symbiote-missing-${Date.now()}`);
  const out = String(await execTool.execute({ command: 'echo should-not-run', workdir: missingWorkdir }));
  assert.match(out, /Working directory does not exist/);
});

test('POSIX executable availability requires execute permission', () => {
  if (process.platform === 'win32') return;
  const executable = path.join(os.tmpdir(), `symbiote-shell-permissions-${process.pid}-${Date.now()}`);
  fs.writeFileSync(executable, '');
  try {
    fs.chmodSync(executable, 0o644);
    assert.equal(isExecutableAvailable(executable), false);
    fs.chmodSync(executable, 0o755);
    assert.equal(isExecutableAvailable(executable), true);
  } finally {
    fs.unlinkSync(executable);
  }
});

test('exec reports an unavailable shell executable clearly', async () => {
  const envKey = process.platform === 'win32' ? 'COMSPEC' : 'SYMBIOTE_SHELL';
  const previous = process.env[envKey];
  process.env[envKey] = path.join(os.tmpdir(), `symbiote-missing-shell-${Date.now()}`);
  try {
    const out = String(await execTool.execute({
      command: 'echo should-not-run',
      shell: process.platform === 'win32' ? 'cmd' : 'powershell',
    }));
    assert.match(out, /Shell executable was not found/);
  } finally {
    if (previous === undefined) delete process.env[envKey];
    else process.env[envKey] = previous;
  }
});

test('EPIPE disables writes to a closed output stream without reporting an operational error', async () => {
  const stream = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const reported: string[] = [];
  guardOutputStream('stdout', stream, (name, error) => reported.push(`${name}:${error.code}`));
  stream.emit('error', Object.assign(new Error('pipe closed'), { code: 'EPIPE' }));
  let callbackCalled = false;
  const accepted = stream.write('ignored', () => { callbackCalled = true; });
  await new Promise<void>(resolve => queueMicrotask(resolve));
  assert.equal(accepted, false);
  assert.equal(callbackCalled, true);
  assert.deepEqual(reported, []);
});

test('exec reports successful commands that intentionally produce no output', async () => {
  const out = await execTool.execute({ command: 'exit 0', timeout: 30 });
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

test('n8n management is hidden and denied outside admin sessions', async () => {
  configureSandbox(undefined);
  let executions = 0;
  const inner = {
    list: () => [
      { name: 'n8n_cloud', description: 'n8n API', parameters: {} },
      { name: 'n8n_workflow', description: 'n8n workflow API', parameters: {} },
      { name: 'n8n_mcp_list_workflows', description: 'n8n MCP', parameters: {} },
    ],
    toProviderFormat: () => [],
    execute: async () => {
      executions++;
      return 'called';
    },
  };
  const context = {
    sessionId: 'n8n-session',
    adapterId: 'discord-main',
    channelType: 'discord',
    chatType: 'direct' as const,
    senderId: 'external-user',
    isOwner: false,
  };

  try {
    const restricted = createSandboxedRegistry(inner, context);
    assert.equal(restricted.list().some(tool => tool.name === 'n8n_cloud'), false);
    assert.equal(restricted.list().some(tool => tool.name === 'n8n_workflow'), false);
    assert.equal(restricted.list().some(tool => tool.name === 'n8n_mcp_list_workflows'), false);
    const denied = JSON.parse(await restricted.execute('n8n_cloud', { method: 'GET', path: '/workflows' })) as {
      error: string;
      sandbox: boolean;
    };
    assert.equal(denied.sandbox, true);
    assert.match(denied.error, /admin sessions/);
    assert.equal(executions, 0);
    const workflowDenied = JSON.parse(await restricted.execute('n8n_workflow', { action: 'list_workflows' })) as {
      error: string;
      sandbox: boolean;
    };
    assert.equal(workflowDenied.sandbox, true);
    assert.match(workflowDenied.error, /admin sessions/);
    assert.equal(executions, 0);
    const mcpDenied = JSON.parse(await restricted.execute('n8n_mcp_list_workflows', {})) as {
      error: string;
      sandbox: boolean;
    };
    assert.equal(mcpDenied.sandbox, true);
    assert.match(mcpDenied.error, /admin sessions/);
    assert.equal(executions, 0);

    const admin = createSandboxedRegistry(inner, { ...context, isOwner: true, senderId: 'owner' });
    assert.equal(admin.list().some(tool => tool.name === 'n8n_cloud'), true);
    assert.equal(admin.list().some(tool => tool.name === 'n8n_workflow'), true);
    assert.equal(admin.list().some(tool => tool.name === 'n8n_mcp_list_workflows'), true);
    assert.equal(await admin.execute('n8n_cloud', { method: 'GET', path: '/workflows' }), 'called');
    assert.equal(await admin.execute('n8n_workflow', { action: 'list_workflows' }), 'called');
    assert.equal(await admin.execute('n8n_mcp_list_workflows', {}), 'called');
    assert.equal(executions, 3);
  } finally {
    configureSandbox(undefined);
  }
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

test('background process rejects a missing working directory before spawning', () => {
  const manager = new ProcessManager();
  const missingWorkdir = path.join(os.tmpdir(), `symbiote-missing-${Date.now()}`);
  assert.throws(() => manager.start('echo should-not-run', missingWorkdir), /Working directory does not exist/);
});

test('background process rejects an unavailable shell executable before spawning', () => {
  const manager = new ProcessManager();
  const envKey = process.platform === 'win32' ? 'COMSPEC' : 'SYMBIOTE_SHELL';
  const previous = process.env[envKey];
  process.env[envKey] = path.join(os.tmpdir(), `symbiote-missing-shell-${Date.now()}`);
  try {
    assert.throws(
      () => manager.start('echo should-not-run', undefined, undefined, process.platform === 'win32' ? 'cmd' : 'powershell'),
      /Shell executable was not found/,
    );
  } finally {
    if (previous === undefined) delete process.env[envKey];
    else process.env[envKey] = previous;
  }
});
