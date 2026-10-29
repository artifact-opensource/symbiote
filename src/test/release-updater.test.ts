import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ReleaseUpdater } from '../updates/release-updater.js';

const version = '5.6.0';
const filename = `Symbiote-${version}-x64.msi`;
const installerBytes = Buffer.from('verified MSI bytes');
const installerHash = createHash('sha256').update(installerBytes).digest('hex');
const baseUrl = `https://github.com/artifact-opensource/symbiote/releases/download/v${version}`;

function releaseResponse(installerUrl = `${baseUrl}/${filename}`): Response {
  return new Response(JSON.stringify({
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    assets: [
      { name: filename, browser_download_url: installerUrl, size: installerBytes.length },
      { name: 'SHA256SUMS-windows.txt', browser_download_url: `${baseUrl}/SHA256SUMS-windows.txt`, size: 100 },
    ],
  }), { status: 200 });
}

function makeUpdater(tempDirectory: string, binary = installerBytes, installerUrl?: string) {
  const releaseStatus = {
    state: 'available' as const,
    currentVersion: '5.5.0',
    latestVersion: version,
    releaseUrl: `${baseUrl}`,
  };
  const fetcher: typeof fetch = async input => {
    const url = String(input);
    if (url.endsWith('/releases/latest')) return releaseResponse(installerUrl);
    if (url.endsWith('/SHA256SUMS-windows.txt')) {
      return new Response(`${installerHash}  ${filename}\n`, { status: 200 });
    }
    return new Response(binary, { status: 200 });
  };
  return new ReleaseUpdater(() => releaseStatus, fetcher, 'win32', tempDirectory);
}

test('Windows updater stages only a correctly hashed stable MSI and cleans it when disposed', async () => {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-release-test-'));
  const updater = makeUpdater(tempDirectory);
  try {
    const result = await updater.prepareWindowsInstaller();
    const installerPath = updater.getInstallerPath();
    assert.equal(result.state, 'ready');
    assert.equal(result.filename, filename);
    assert.equal(result.sha256, installerHash);
    assert.equal(result.downloadedBytes, installerBytes.length);
    assert.equal(result.totalBytes, installerBytes.length);
    assert.ok(installerPath);
    assert.deepEqual(fs.readFileSync(installerPath), installerBytes);
    updater.disposeStagedInstaller();
    assert.equal(updater.getInstallerPath(), undefined);
    assert.equal(fs.readdirSync(tempDirectory).length, 0);
  } finally {
    updater.disposeStagedInstaller();
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('Windows updater rejects checksum mismatches and untrusted asset URLs', async () => {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-release-test-'));
  try {
    const mismatch = makeUpdater(tempDirectory, Buffer.from('tampered MSI bytes'));
    await assert.rejects(mismatch.prepareWindowsInstaller(), /checksum does not match/);
    assert.equal(mismatch.getStatus().state, 'error');

    const untrusted = makeUpdater(tempDirectory, installerBytes, 'https://attacker.example/installer.msi');
    await assert.rejects(untrusted.prepareWindowsInstaller(), /outside the trusted GitHub release/);
    assert.equal(untrusted.getStatus().state, 'error');
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('Windows updater refuses install preparation on other platforms or without an available release', async () => {
  const updater = new ReleaseUpdater(
    () => ({ state: 'current', currentVersion: '5.5.0' }),
    fetch,
    'linux',
  );
  await assert.rejects(updater.prepareWindowsInstaller(), /only on Windows/);

  const windowsUpdater = new ReleaseUpdater(
    () => ({ state: 'current', currentVersion: '5.5.0' }),
    fetch,
    'win32',
  );
  await assert.rejects(windowsUpdater.prepareWindowsInstaller(), /no verified newer stable release/);
});
