import assert from 'node:assert/strict';
import test from 'node:test';
import { runAgent } from '../agent/runner.js';
import { createGoogleWorkspaceTool } from '../tools/builtin/google-workspace.js';
import { ToolRegistry } from '../tools/registry.js';

test('Google Workspace tool sends the short-lived bearer token to the selected Google API', async () => {
  let requestedUrl = '';
  let requestInit: RequestInit | undefined;
  const tool = createGoogleWorkspaceTool(async (input, init) => {
    requestedUrl = String(input);
    requestInit = init;
    return new Response(JSON.stringify({ id: 'document-1' }), { status: 200 });
  });

  const result = await tool.execute({
    host: 'docs.googleapis.com',
    path: '/v1/documents/document-1',
    method: 'PATCH',
    query: { includeTabsContent: true },
    body: { title: 'Updated title' },
  }, { googleWorkspaceAccessToken: 'ephemeral-token' });

  assert.equal(requestedUrl, 'https://docs.googleapis.com/v1/documents/document-1?includeTabsContent=true');
  const authorization = new Headers(requestInit?.headers).get('Authorization') ?? '';
  assert.equal(authorization.split(' ')[0], 'Bearer');
  assert.ok(authorization.length > 'Bearer '.length);
  assert.equal(requestInit?.method, 'PATCH');
  assert.deepEqual(JSON.parse(String(requestInit?.body)), { title: 'Updated title' });
  assert.deepEqual(JSON.parse(result), { id: 'document-1' });
});

test('Google Workspace tool can route requests to every Workspace API', async () => {
  const applications = [
    ['www.googleapis.com', '/drive/v3/files'],
    ['gmail.googleapis.com', '/v1/users/me/profile'],
    ['calendar.googleapis.com', '/calendar/v3/calendars/primary'],
    ['people.googleapis.com', '/v1/people/me'],
    ['docs.googleapis.com', '/v1/documents/document-1'],
    ['sheets.googleapis.com', '/v4/spreadsheets/sheet-1'],
    ['slides.googleapis.com', '/v1/presentations/slides-1'],
    ['tasks.googleapis.com', '/tasks/v1/users/@me/lists'],
    ['chat.googleapis.com', '/v1/spaces'],
    ['forms.googleapis.com', '/v1/forms/form-1'],
  ] as const;
  const visited: string[] = [];
  const tool = createGoogleWorkspaceTool(async input => {
    visited.push(String(input));
    return new Response('{}');
  });

  for (const [host, path] of applications) {
    const result = await tool.execute({ host, path, method: 'GET' }, { googleWorkspaceAccessToken: 'ephemeral-token' });
    assert.deepEqual(JSON.parse(result), {});
  }
  assert.deepEqual(visited, applications.map(([host, path]) => `https://${host}${path}`));
});

test('Google Workspace tool rejects missing access, non-Google hosts, and malformed API paths', async () => {
  let fetchCount = 0;
  const tool = createGoogleWorkspaceTool(async () => {
    fetchCount += 1;
    return new Response('{}');
  });
  const input = { host: 'www.googleapis.com', path: '/v1/drive/files', method: 'GET' };

  assert.match(await tool.execute(input), /not enabled for this agent turn/);
  assert.match(await tool.execute({ ...input, host: 'example.com' }, { googleWorkspaceAccessToken: 'token' }), /Unsupported Google API host/);
  assert.match(await tool.execute({ ...input, path: '//example.com/v1/files' }, { googleWorkspaceAccessToken: 'token' }), /versioned Google API path/);
  assert.equal(fetchCount, 0);
});

test('Google Workspace tool surfaces API errors without returning credentials', async () => {
  const tool = createGoogleWorkspaceTool(async () => new Response(
    JSON.stringify({ error: { message: 'Permission denied by Workspace policy.' } }),
    { status: 403 },
  ));
  const result = await tool.execute({
    host: 'gmail.googleapis.com',
    path: '/v1/users/me/messages/send',
    method: 'POST',
    body: { raw: 'encoded-message' },
  }, { googleWorkspaceAccessToken: 'do-not-leak-this-token' });

  assert.match(result, /Permission denied by Workspace policy/);
  assert.doesNotMatch(result, /do-not-leak-this-token/);
});

test('web agent turns pass the OAuth grant to tools without adding it to conversation messages', async () => {
  const token = 'ephemeral-token-for-tool';
  let authorization = '';
  const tool = createGoogleWorkspaceTool(async (_input, init) => {
    authorization = new Headers(init?.headers).get('Authorization') ?? '';
    return new Response('{"ok":true}');
  });
  const registry = new ToolRegistry();
  registry.register(tool);
  let modelCall = 0;
  const provider = {
    name: 'test-provider',
    async *stream() {
      if (modelCall++ === 0) {
        yield { type: 'tool_use_start', id: 'tool-1', name: 'google_workspace' };
        yield { type: 'tool_use_delta', id: 'tool-1', input: '{"host":"docs.googleapis.com","path":"/v1/documents/doc-1","method":"GET"}' };
        yield { type: 'tool_use_end', id: 'tool-1' };
        yield { type: 'done', stopReason: 'tool_use' };
        return;
      }
      yield { type: 'text_delta', text: 'Document checked.' };
      yield { type: 'done', stopReason: 'end_turn' };
    },
  };

  const result = await runAgent([{ role: 'user', content: 'Check the document.' }], {
    provider: provider as never,
    providerConfig: { model: 'test', maxTokens: 100 },
    toolRegistry: registry,
    googleWorkspaceAccessToken: token,
    maxIterations: 3,
    onProgress: () => undefined,
  });

  assert.equal(authorization.split(' ')[0], 'Bearer');
  assert.ok(authorization.endsWith(token));
  assert.equal(result.text, 'Document checked.');
  assert.ok(result.messages.every(message => !JSON.stringify(message).includes(token)));
});
