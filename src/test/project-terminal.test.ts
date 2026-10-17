import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectTerminalManager } from '../web/project-terminal.js';

test('project terminals keep a shell session alive, stream output, and enforce project ownership', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-terminal-'));
  const otherWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-terminal-other-'));
  const terminals = new ProjectTerminalManager();
  try {
    const started = terminals.start('project-a', workspace);
    assert.throws(() => terminals.poll('project-b', started.terminalId), /not found/);

    const command = process.platform === 'win32'
      ? 'Write-Output persistent-terminal-marker'
      : 'printf persistent-terminal-marker';
    terminals.write('project-a', started.terminalId, `${command}\n`);

    let result = terminals.poll('project-a', started.terminalId);
    const deadline = Date.now() + 5_000;
    while (!result.output.includes('persistent-terminal-marker') && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
      result = terminals.poll('project-a', started.terminalId);
    }
    assert.match(result.output, /persistent-terminal-marker/);
    assert.equal(result.running, true);

    terminals.write('project-a', started.terminalId, process.platform === 'win32' ? 'exit\n' : 'exit\n');
    const exitDeadline = Date.now() + 5_000;
    while (result.running && Date.now() < exitDeadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
      result = terminals.poll('project-a', started.terminalId);
    }
    assert.equal(result.running, false);
    assert.equal(await terminals.killProject('project-a'), 0);

    const next = terminals.start('project-b', otherWorkspace);
    assert.throws(() => terminals.write('project-a', next.terminalId, 'echo wrong-project\n'), /not found/);
    assert.equal(await terminals.killProject('project-b'), 1);
  } finally {
    await terminals.stopAll();
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(otherWorkspace, { recursive: true, force: true });
  }
});
