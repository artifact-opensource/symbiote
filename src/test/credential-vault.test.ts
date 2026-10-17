import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CredentialVault } from '../security/credential-vault.js';

test('credential vault encrypts provider secrets and preserves other external environment entries', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'symbiote-vault-'));
  const adminEnvPath = path.join(directory, '.admin', '.env');
  const vaultPath = path.join(directory, '.symbiote', 'vault', 'integrations.enc');
  const environmentText = 'EXISTING_SETTING=preserve-me\n';
  mkdirSync(path.dirname(adminEnvPath), { recursive: true });
  writeFileSync(adminEnvPath, environmentText);
  const vault = new CredentialVault({ adminEnvPath, vaultPath });

  try {
    vault.set('n8n', { baseUrl: 'https://sample.app.n8n.cloud/api/v1', apiKey: 'n8n-secret' });

    const stored = readFileSync(vaultPath, 'utf8');
    assert.doesNotMatch(stored, /n8n-secret|sample\.app\.n8n\.cloud/);
    assert.match(readFileSync(adminEnvPath, 'utf8'), /^EXISTING_SETTING=preserve-me\nSYMBIOTE_VAULT_KEY=/);
    assert.deepEqual(vault.get('n8n'), { baseUrl: 'https://sample.app.n8n.cloud/api/v1', apiKey: 'n8n-secret' });
    vault.set('n8n', { apiKey: '' });
    assert.equal(vault.get('n8n')?.apiKey, 'n8n-secret');
    assert.equal(vault.has('n8n'), true);
    vault.delete('n8n');
    assert.equal(vault.has('n8n'), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('credential vault refuses to decrypt with a changed external key', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'symbiote-vault-tamper-'));
  const adminEnvPath = path.join(directory, '.admin', '.env');
  const vaultPath = path.join(directory, '.symbiote', 'integrations.enc');
  const vault = new CredentialVault({ adminEnvPath, vaultPath });

  try {
    vault.set('kaggle', { username: 'researcher', apiToken: 'private-token' });
    writeFileSync(adminEnvPath, 'SYMBIOTE_VAULT_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n');
    assert.throws(() => vault.get('kaggle'), /Could not decrypt the integration vault/);
    assert.ok(readFileSync(vaultPath, 'utf8').length > 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
