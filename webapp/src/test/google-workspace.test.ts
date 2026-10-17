import assert from 'node:assert/strict';
import test from 'node:test';
import { GOOGLE_WORKSPACE_SCOPES, GOOGLE_WORKSPACE_SERVICES, inspectGoogleWorkspaceService } from '../lib/googleWorkspace.ts';

test('Google Drive inspection requests recent file metadata with a bearer token', async () => {
  let requestedUrl = '';
  let authorization = '';
  const fetcher: typeof fetch = async (input, init) => {
    requestedUrl = String(input);
    authorization = new Headers(init?.headers).get('Authorization') ?? '';
    return new Response(JSON.stringify({
      files: [{ id: 'file-1', name: 'Project notes', mimeType: 'text/plain', modifiedTime: '2026-10-16T00:00:00Z', webViewLink: 'https://drive.google.com/file/d/file-1/view' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const items = await inspectGoogleWorkspaceService('drive', 'oauth-access-token', fetcher);

  assert.equal(authorization, 'Bearer oauth-access-token');
  assert.match(requestedUrl, /drive\/v3\/files\?/);
  assert.deepEqual(items, [{
    id: 'file-1',
    title: 'Project notes',
    detail: '2026-10-16T00:00:00Z',
    url: 'https://drive.google.com/file/d/file-1/view',
  }]);
});

test('Gmail inspection reads only message headers, never message bodies', async () => {
  const requestedUrls: string[] = [];
  const fetcher: typeof fetch = async input => {
    const url = String(input);
    requestedUrls.push(url);
    const body = url.includes('/messages?')
      ? { messages: [{ id: 'message-1' }] }
      : { payload: { headers: [{ name: 'Subject', value: 'Build update' }, { name: 'From', value: 'agent@example.test' }] } };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const items = await inspectGoogleWorkspaceService('gmail', 'oauth-access-token', fetcher);

  assert.equal(items.length, 1);
  assert.deepEqual(items[0], { id: 'message-1', title: 'Build update', detail: 'agent@example.test' });
  assert.ok(requestedUrls.every(url => !url.includes('format=full')));
  assert.ok(requestedUrls[1].includes('format=metadata'));
});

test('Google Workspace API failures are surfaced without hiding Google error details', async () => {
  const fetcher: typeof fetch = async () => new Response(JSON.stringify({
    error: { message: 'Google Drive API has not been enabled for this project.' },
  }), { status: 403, headers: { 'Content-Type': 'application/json' } });

  await assert.rejects(
    inspectGoogleWorkspaceService('drive', 'oauth-access-token', fetcher),
    /Google Drive API has not been enabled/,
  );
});

test('Google Workspace inspection rejects missing tokens and unknown services', async () => {
  await assert.rejects(inspectGoogleWorkspaceService('drive', ''), /did not return an access token/);
  await assert.rejects(inspectGoogleWorkspaceService('unknown', 'oauth-access-token'), /Unsupported Google Workspace service/);
});

test('one Google OAuth grant requests all Workspace scopes', () => {
  assert.equal(new Set(GOOGLE_WORKSPACE_SCOPES).size, GOOGLE_WORKSPACE_SCOPES.length);
  assert.ok(!GOOGLE_WORKSPACE_SCOPES.some(scope => scope === 'https://www.googleapis.com/auth/forms.responses'));
  assert.deepEqual(GOOGLE_WORKSPACE_SERVICES.find(service => service.id === 'forms')?.scopes, [
    'https://www.googleapis.com/auth/forms.body',
    'https://www.googleapis.com/auth/forms.responses.readonly',
  ]);
  for (const service of GOOGLE_WORKSPACE_SERVICES) {
    for (const scope of service.scopes) assert.ok(GOOGLE_WORKSPACE_SCOPES.includes(scope as typeof GOOGLE_WORKSPACE_SCOPES[number]));
  }
});

test('each Workspace app can be probed with one access token', async () => {
  const expectedPaths: Record<string, RegExp[]> = {
    drive: [/drive\/v3\/files\?/],
    gmail: [/gmail\/v1\/users\/me\/messages\?/],
    calendar: [/calendar\/v3\/calendars\/primary\/events\?/],
    contacts: [/people\/v1\/people\/me\/connections\?/],
    docs: [/drive\/v3\/files\?.*application%2Fvnd\.google-apps\.document/, /https:\/\/docs\.googleapis\.com\/v1\/documents\/sample-file\?fields=documentId,title/],
    sheets: [/drive\/v3\/files\?.*application%2Fvnd\.google-apps\.spreadsheet/, /https:\/\/sheets\.googleapis\.com\/v4\/spreadsheets\/sample-file\?includeGridData=false&fields=spreadsheetId,properties\.title/],
    slides: [/drive\/v3\/files\?.*application%2Fvnd\.google-apps\.presentation/, /https:\/\/slides\.googleapis\.com\/v1\/presentations\/sample-file\?fields=presentationId,title/],
    tasks: [/tasks\/v1\/users\/@me\/lists\?/],
    chat: [/chat\/v1\/spaces\?/],
    forms: [/drive\/v3\/files\?.*application%2Fvnd\.google-apps\.form/, /https:\/\/forms\.googleapis\.com\/v1\/forms\/sample-file\?fields=formId,info\.title/],
  };

  for (const service of GOOGLE_WORKSPACE_SERVICES) {
    const requestedUrls: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const requestedUrl = String(input);
      requestedUrls.push(requestedUrl);
      const authorization = new Headers(init?.headers).get('Authorization') ?? '';
      assert.equal(authorization.split(' ')[0], 'Bearer');
      assert.ok(authorization.length > 'Bearer '.length);
      const hasSampleFile = ['docs', 'sheets', 'slides', 'forms'].includes(service.id)
        && requestedUrl.includes('/drive/v3/files?');
      if (hasSampleFile) assert.equal(new URL(requestedUrl).searchParams.get('pageSize'), '1');
      return new Response(JSON.stringify(hasSampleFile
        ? { files: [{ id: 'sample-file', name: `Sample ${service.name}`, modifiedTime: '2026-10-16T00:00:00Z' }] }
        : { messages: [], files: [], items: [], connections: [], spaces: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    await inspectGoogleWorkspaceService(service.id, 'oauth-access-token', fetcher);
    for (const expectedPath of expectedPaths[service.id]) {
      assert.ok(requestedUrls.some(requestedUrl => expectedPath.test(requestedUrl)), `${service.name} should call ${expectedPath}`);
    }
  }
});

test('Docs reports when no accessible file exists to verify the Docs API', async () => {
  const fetcher: typeof fetch = async () => new Response(JSON.stringify({ files: [] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  await assert.rejects(
    inspectGoogleWorkspaceService('docs', 'oauth-access-token', fetcher),
    /No accessible Docs file was found to verify its API/,
  );
});
