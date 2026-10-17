import assert from 'node:assert/strict';
import test from 'node:test';
import { ReleaseChecker } from '../updates/release-checker.js';

const releaseResponse = (tag: string) => new Response(JSON.stringify({
  tag_name: tag,
  html_url: `https://github.com/artifact-opensource/symbiote/releases/tag/${tag}`,
  published_at: '2026-10-16T00:00:00Z',
  draft: false,
  prerelease: false,
}), { status: 200, headers: { 'content-type': 'application/json' } });

test('release checker reports a newer stable semantic version', async () => {
  const checker = new ReleaseChecker('5.3.0', async () => releaseResponse('v5.4.0'));
  const status = await checker.refresh();
  assert.equal(status.state, 'available');
  assert.equal(status.latestVersion, '5.4.0');
  assert.match(status.releaseUrl ?? '', /releases\/tag\/v5\.4\.0$/);
  assert.equal(status.publishedAt, '2026-10-16T00:00:00Z');
});

test('release checker marks the current version as up to date', async () => {
  const checker = new ReleaseChecker('5.3.0', async () => releaseResponse('v5.3.0'));
  assert.equal((await checker.refresh()).state, 'current');
});

test('release checker exposes network and malformed release errors', async () => {
  const offline = new ReleaseChecker('5.3.0', async () => { throw new Error('offline'); });
  const offlineStatus = await offline.refresh();
  assert.equal(offlineStatus.state, 'error');
  assert.match(offlineStatus.error ?? '', /offline/);

  const invalid = new ReleaseChecker('5.3.0', async () => releaseResponse('v5.4'));
  assert.match((await invalid.refresh()).error ?? '', /invalid semantic version/);
});

test('concurrent release checks share one request', async () => {
  let calls = 0;
  const checker = new ReleaseChecker('5.3.0', async () => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 10));
    return releaseResponse('v5.3.0');
  });
  const [first, second] = await Promise.all([checker.refresh(), checker.refresh()]);
  assert.equal(calls, 1);
  assert.deepEqual(first, second);
});
