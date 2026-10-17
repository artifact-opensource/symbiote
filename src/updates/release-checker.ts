export interface ReleaseUpdateStatus {
  state: 'unknown' | 'current' | 'available' | 'error';
  currentVersion: string;
  latestVersion?: string;
  releaseUrl?: string;
  publishedAt?: string;
  checkedAt?: number;
  error?: string;
}

interface GitHubRelease {
  tag_name?: unknown;
  html_url?: unknown;
  published_at?: unknown;
  draft?: unknown;
  prerelease?: unknown;
}

const RELEASE_URL = 'https://api.github.com/repos/artifact-opensource/symbiote/releases/latest';
const RELEASE_PAGE = 'https://github.com/artifact-opensource/symbiote/releases/latest';
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const RETRY_INTERVAL_MS = 10 * 60 * 1000;

function versionParts(value: string): number[] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value);
  return match ? match.slice(1).map(Number) : null;
}

function isNewer(candidate: string, current: string): boolean {
  const latestParts = versionParts(candidate);
  const currentParts = versionParts(current);
  if (!latestParts || !currentParts) return false;
  for (let index = 0; index < latestParts.length; index++) {
    if (latestParts[index] !== currentParts[index]) return latestParts[index] > currentParts[index];
  }
  return false;
}

export class ReleaseChecker {
  private status: ReleaseUpdateStatus;
  private timer: ReturnType<typeof setInterval> | undefined;
  private checking: Promise<ReleaseUpdateStatus> | undefined;

  constructor(
    private readonly currentVersion: string,
    private readonly fetchRelease: typeof fetch = fetch,
  ) {
    this.status = { state: 'unknown', currentVersion };
  }

  getStatus(): ReleaseUpdateStatus {
    return { ...this.status };
  }

  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, REFRESH_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  refresh(): Promise<ReleaseUpdateStatus> {
    if (this.checking) return this.checking;
    this.checking = this.checkOnce().finally(() => { this.checking = undefined; });
    return this.checking;
  }

  private async checkOnce(): Promise<ReleaseUpdateStatus> {
    try {
      const response = await this.fetchRelease(RELEASE_URL, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'Symbiote-Update-Checker',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`GitHub release lookup returned HTTP ${response.status}.`);
      const release = await response.json() as GitHubRelease;
      if (release.draft === true || release.prerelease === true) {
        throw new Error('GitHub did not return a stable release.');
      }
      if (typeof release.tag_name !== 'string' || !versionParts(release.tag_name)) {
        throw new Error('GitHub release has an invalid semantic version tag.');
      }
      const latestVersion = release.tag_name.replace(/^v/, '');
      this.status = {
        state: isNewer(latestVersion, this.currentVersion) ? 'available' : 'current',
        currentVersion: this.currentVersion,
        latestVersion,
        releaseUrl: typeof release.html_url === 'string' ? release.html_url : RELEASE_PAGE,
        ...(typeof release.published_at === 'string' ? { publishedAt: release.published_at } : {}),
        checkedAt: Date.now(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.status = {
        state: 'error',
        currentVersion: this.currentVersion,
        releaseUrl: RELEASE_PAGE,
        checkedAt: Date.now(),
        error: message.slice(0, 240),
      };
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = setInterval(() => { void this.refresh(); }, RETRY_INTERVAL_MS);
        this.timer.unref?.();
      }
    }
    return this.getStatus();
  }
}
