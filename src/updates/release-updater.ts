import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, mkdtempSync, rmSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReleaseUpdateStatus } from './release-checker.js';

interface GitHubReleaseAsset {
  name?: unknown;
  browser_download_url?: unknown;
  size?: unknown;
}

interface GitHubRelease {
  tag_name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  assets?: unknown;
}

export interface ReleaseDownloadStatus {
  state: 'idle' | 'downloading' | 'ready' | 'error';
  version?: string;
  filename?: string;
  sha256?: string;
  error?: string;
}

const RELEASE_API = 'https://api.github.com/repos/artifact-opensource/symbiote/releases/latest';
const RELEASE_ASSET_PREFIX = 'https://github.com/artifact-opensource/symbiote/releases/download/';
const MAX_INSTALLER_BYTES = 1024 * 1024 * 1024;

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export class ReleaseUpdater {
  private download: ReleaseDownloadStatus = { state: 'idle' };
  private stagingDirectory: string | undefined;
  private preparing: Promise<ReleaseDownloadStatus> | undefined;

  constructor(
    private readonly getReleaseStatus: () => ReleaseUpdateStatus,
    private readonly fetchRelease: typeof fetch = fetch,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly tempDirectory = os.tmpdir(),
  ) {}

  getStatus(): ReleaseDownloadStatus {
    return { ...this.download };
  }

  getInstallerPath(): string | undefined {
    if (this.download.state !== 'ready' || !this.download.filename || !this.stagingDirectory) return undefined;
    return path.join(this.stagingDirectory, this.download.filename);
  }

  prepareWindowsInstaller(): Promise<ReleaseDownloadStatus> {
    if (this.preparing) return this.preparing;
    this.preparing = this.prepare().finally(() => { this.preparing = undefined; });
    return this.preparing;
  }

  private async prepare(): Promise<ReleaseDownloadStatus> {
    const releaseStatus = this.getReleaseStatus();
    if (this.platform !== 'win32') throw new Error('In-app MSI installation is available only on Windows.');
    if (releaseStatus.state !== 'available' || !releaseStatus.latestVersion) {
      throw new Error('There is no verified newer stable release available to install.');
    }

    this.disposeStagedInstaller();
    this.download = { state: 'downloading', version: releaseStatus.latestVersion };
    let directory: string | undefined;
    try {
      const response = await this.fetchRelease(RELEASE_API, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'Symbiote-Release-Updater',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`GitHub release lookup returned HTTP ${response.status}.`);
      const release = await response.json() as GitHubRelease;
      if (release.draft === true || release.prerelease === true || release.tag_name !== `v${releaseStatus.latestVersion}`) {
        throw new Error('The stable release changed during update preparation. Check for updates and try again.');
      }
      if (!Array.isArray(release.assets)) throw new Error('The GitHub release has no downloadable assets.');
      const assets = release.assets as GitHubReleaseAsset[];
      const filename = `Symbiote-${releaseStatus.latestVersion}-x64.msi`;
      const installer = assets.find(asset => asset.name === filename);
      const checksums = assets.find(asset => asset.name === 'SHA256SUMS-windows.txt');
      if (typeof installer?.browser_download_url !== 'string' || typeof installer.size !== 'number'
        || installer.size <= 0 || installer.size > MAX_INSTALLER_BYTES
        || typeof checksums?.browser_download_url !== 'string'
        || typeof checksums.size !== 'number' || checksums.size <= 0 || checksums.size > 64 * 1024) {
        throw new Error(`The stable release does not contain a valid Windows installer for ${releaseStatus.latestVersion}.`);
      }
      const installerSize = installer.size;
      const expectedUrlPrefix = `${RELEASE_ASSET_PREFIX}v${releaseStatus.latestVersion}/`;
      for (const url of [installer.browser_download_url, checksums.browser_download_url]) {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' || parsed.host !== 'github.com' || !parsed.href.startsWith(expectedUrlPrefix)) {
          throw new Error('The release contains an installer link outside the trusted GitHub release.');
        }
      }

      const checksumResponse = await this.fetchRelease(checksums.browser_download_url, {
        signal: AbortSignal.timeout(20_000),
      });
      if (!checksumResponse.ok) throw new Error(`Windows checksum download returned HTTP ${checksumResponse.status}.`);
      const checksumLength = Number(checksumResponse.headers.get('content-length'));
      if (Number.isFinite(checksumLength) && checksumLength > 64 * 1024) {
        throw new Error('The Windows checksum manifest is unexpectedly large.');
      }
      const checksumText = await checksumResponse.text();
      if (checksumText.length > 64 * 1024) throw new Error('The Windows checksum manifest is unexpectedly large.');
      const checksumLine = checksumText.split(/\r?\n/).find(line => line.trim().endsWith(`  ${filename}`));
      const expectedHash = checksumLine?.trim().split(/\s+/)[0]?.toLowerCase();
      if (!expectedHash || !/^[a-f0-9]{64}$/.test(expectedHash)) {
        throw new Error(`The Windows checksum manifest does not contain a valid hash for ${filename}.`);
      }

      const installerResponse = await this.fetchRelease(installer.browser_download_url, {
        signal: AbortSignal.timeout(15 * 60_000),
      });
      if (!installerResponse.ok || !installerResponse.body) {
        throw new Error(`Windows installer download returned HTTP ${installerResponse.status}.`);
      }
      const contentLength = Number(installerResponse.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > MAX_INSTALLER_BYTES) {
        throw new Error('The Windows installer exceeds the maximum allowed download size.');
      }
      directory = mkdtempSync(path.join(this.tempDirectory, 'symbiote-update-'));
      const installerPath = path.join(directory, filename);
      const reader = installerResponse.body.getReader();
      async function* chunks(): AsyncGenerator<Uint8Array> {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) return;
            yield value;
          }
        } finally {
          reader.releaseLock();
        }
      }
      let bytesReceived = 0;
      const enforceSize = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytesReceived += chunk.length;
          if (bytesReceived > installerSize || bytesReceived > MAX_INSTALLER_BYTES) {
            callback(new Error('The Windows installer exceeds its declared release size.'));
            return;
          }
          callback(null, chunk);
        },
      });
      await pipeline(
        Readable.from(chunks()),
        enforceSize,
        createWriteStream(installerPath, { flags: 'wx', mode: 0o600 }),
      );
      const downloadedSize = (await stat(installerPath)).size;
      if (downloadedSize !== installerSize || downloadedSize > MAX_INSTALLER_BYTES) {
        throw new Error('The downloaded Windows installer size does not match the release metadata.');
      }
      const actualHash = await sha256File(installerPath);
      if (actualHash !== expectedHash) throw new Error('The Windows installer checksum does not match the published SHA-256 manifest.');

      this.stagingDirectory = directory;
      this.download = { state: 'ready', version: releaseStatus.latestVersion, filename, sha256: actualHash };
      return this.getStatus();
    } catch (error) {
      if (directory) rmSync(directory, { recursive: true, force: true });
      const message = error instanceof Error ? error.message : String(error);
      this.download = { state: 'error', version: releaseStatus.latestVersion, error: message.slice(0, 240) };
      throw error;
    }
  }

  disposeStagedInstaller(): void {
    if (this.stagingDirectory) {
      rmSync(this.stagingDirectory, { recursive: true, force: true });
    }
    this.stagingDirectory = undefined;
    if (this.download.state === 'ready') this.download = { state: 'idle' };
  }
}
