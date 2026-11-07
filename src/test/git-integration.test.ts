import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { GitService } from '../git/service.js';
import { createGitTool } from '../tools/builtin/git.js';

const execFileAsync = promisify(execFile);

test('native Git integration commits with the configured identity and pushes to any Git remote', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-git-'));
  const repository = path.join(directory, 'repo');
  const remote = path.join(directory, 'remote.git');
  const service = new GitService(path.join(directory, 'identity.json'));

  try {
    fs.mkdirSync(repository);
    await execFileAsync('git', ['init', '--bare', remote]);
    await execFileAsync('git', ['init', repository]);
    service.saveIdentity({ userName: 'Symbiote Test', userEmail: 'symbiote@example.test' });
    fs.writeFileSync(path.join(repository, 'README.md'), 'Native Git integration\n');

    assert.match(await service.execute({ action: 'status', repositoryPath: repository }), /README\.md/);
    await service.execute({ action: 'stage', repositoryPath: repository, paths: ['README.md'] });
    await service.execute({ action: 'commit', repositoryPath: repository, message: 'Add test README' });
    assert.match(
      (await execFileAsync('git', ['-C', repository, 'log', '-1', '--format=%an <%ae>'])).stdout,
      /^Symbiote Test <symbiote@example\.test>/,
    );

    await execFileAsync('git', ['-C', repository, 'remote', 'add', 'origin', remote]);
    await service.execute({ action: 'push', repositoryPath: repository, remote: 'origin' });
    const refs = (await execFileAsync('git', ['--git-dir', remote, 'show-ref'])).stdout;
    assert.match(refs, /refs\/heads\//);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('native Git identity validates paired fields without mutating global Git config', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-git-identity-'));
  const identityPath = path.join(directory, 'identity.json');
  const service = new GitService(identityPath);

  try {
    assert.deepEqual(service.getIdentity(), { userName: '', userEmail: '' });
    assert.throws(() => service.saveIdentity({ userName: 'Only a name', userEmail: '' }), /Set both Git user name and email/);
    assert.throws(() => service.saveIdentity({ userName: 'Name', userEmail: 'not-an-email' }), /valid email/);
    assert.deepEqual(
      service.saveIdentity({ userName: '  A Contributor  ', userEmail: '  dev@example.com  ' }),
      { userName: 'A Contributor', userEmail: 'dev@example.com' },
    );
    assert.deepEqual(service.getIdentity(), { userName: 'A Contributor', userEmail: 'dev@example.com' });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('native Git tool exposes the supported host-agnostic operations', () => {
  const tool = createGitTool(new GitService(path.join(os.tmpdir(), 'symbiote-git-tool-test.json')));
  assert.equal(tool.name, 'git');
  assert.deepEqual(tool.parameters.properties.action.enum, [
    'status', 'diff', 'log', 'branch_list', 'remote_list', 'stage', 'commit', 'fetch', 'pull', 'push',
  ]);
  assert.match(tool.description, /Gitee/);
  assert.match(tool.description, /explicitly requested by the user/);
});
