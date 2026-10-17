import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('workspace identity stores validated agent avatars outside the workspace', async () => {
  const originalHome = process.env.SYMBIOTE_HOME;
  const appHome = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-avatar-home-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-avatar-workspace-'));
  process.env.SYMBIOTE_HOME = appHome;

  try {
    const { readAgentAvatarDataUrl, updateWorkspaceIdentity } = await import('../agent/workspace-identity.js');
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/qisAAAAASUVORK5CYII=';
    const avatarDataUrl = `data:image/png;base64,${png}`;
    const update = {
      name: 'Test agent',
      emoji: '🤖',
      soulContent: '# Test\n',
      agentsContent: '- Name: Test agent\n',
      instructions: '',
    };

    updateWorkspaceIdentity(workspace, { ...update, avatarDataUrl });
    assert.equal(readAgentAvatarDataUrl(), avatarDataUrl);
    assert.equal(fs.existsSync(path.join(workspace, 'agent-avatar.png')), false);
    assert.throws(() => updateWorkspaceIdentity(workspace, {
      ...update,
      avatarDataUrl: 'data:image/png;base64,ZmFrZQ==',
    }), /valid image/);
    updateWorkspaceIdentity(workspace, { ...update, avatarDataUrl: null });
    assert.equal(readAgentAvatarDataUrl(), undefined);
  } finally {
    if (originalHome === undefined) delete process.env.SYMBIOTE_HOME;
    else process.env.SYMBIOTE_HOME = originalHome;
    fs.rmSync(appHome, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
