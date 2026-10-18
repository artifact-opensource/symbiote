import type { ToolDefinition } from '../types.js';

const GOOGLE_API_HOSTS = new Set([
  'www.googleapis.com',
  'calendar.googleapis.com',
  'chat.googleapis.com',
  'docs.googleapis.com',
  'forms.googleapis.com',
  'gmail.googleapis.com',
  'people.googleapis.com',
  'sheets.googleapis.com',
  'slides.googleapis.com',
  'tasks.googleapis.com',
]);

type FetchLike = typeof fetch;

export function createGoogleWorkspaceTool(fetcher: FetchLike = fetch): ToolDefinition {
  return {
    name: 'google_workspace',
    description: 'Make an authenticated Google Workspace API request using the connected user grant. Supports reading and changing Google Drive, Gmail (including sending mail), Calendar, Contacts, Docs, Sheets, Slides, Tasks, Chat, and Forms. Use only when the user has connected Google Workspace in Configuration > Integrations. Changes are applied immediately under the connected Google account.',
    parameters: {
      type: 'object',
      properties: {
        host: {
          type: 'string',
          description: 'Google API hostname, such as www.googleapis.com, gmail.googleapis.com, docs.googleapis.com, or sheets.googleapis.com.',
          enum: [...GOOGLE_API_HOSTS],
        },
        path: { type: 'string', description: 'API path beginning with /v1/, /v2/, or another version segment; do not include the hostname or query string.' },
        method: { type: 'string', description: 'HTTP method. Use GET to read, POST/PUT/PATCH to create or change, and DELETE to remove.', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
        query: { type: 'object', description: 'Optional query parameters as string, number, or boolean values.' },
        body: { type: 'object', description: 'Optional JSON request body for POST, PUT, or PATCH.' },
      },
      required: ['host', 'path', 'method'],
    },
    idempotency: {
      class: 'external',
      externalSystem: 'Google Workspace API',
      idempotencyKey: (input) => `google_workspace:${String(input.host ?? '')}:${String(input.path ?? '')}:${String(input.method ?? '')}:${JSON.stringify(input.query ?? {})}:${JSON.stringify(input.body ?? {})}`,
    },
    async execute(input, options) {
      const accessToken = options?.googleWorkspaceAccessToken;
      if (!accessToken) {
        return JSON.stringify({ error: 'Google Workspace is not enabled for this agent turn. Connect Google Workspace in Configuration > Integrations and retry.' });
      }

      const host = typeof input.host === 'string' ? input.host : '';
      const apiPath = typeof input.path === 'string' ? input.path : '';
      const method = typeof input.method === 'string' ? input.method.toUpperCase() : '';
      if (!GOOGLE_API_HOSTS.has(host)) return JSON.stringify({ error: 'Unsupported Google API host.' });
      if (!/^\/(?:[A-Za-z0-9_-]+\/)?v\d+(?:beta\d*)?\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(apiPath) || apiPath.includes('..')) {
        return JSON.stringify({ error: 'API path must be a versioned Google API path.' });
      }
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
        return JSON.stringify({ error: 'Unsupported Google API method.' });
      }

      const url = new URL(apiPath, `https://${host}`);
      const query = input.query;
      if (query !== undefined) {
        if (!query || typeof query !== 'object' || Array.isArray(query)) {
          return JSON.stringify({ error: 'Query parameters must be an object.' });
        }
        for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
          if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(key) || !['string', 'number', 'boolean'].includes(typeof value)) {
            return JSON.stringify({ error: `Invalid Google API query parameter: ${key}` });
          }
          url.searchParams.set(key, String(value));
        }
      }

      let body: string | undefined;
      if (input.body !== undefined) {
        if (!input.body || typeof input.body !== 'object' || Array.isArray(input.body)) {
          return JSON.stringify({ error: 'Google API request body must be a JSON object.' });
        }
        body = JSON.stringify(input.body);
        if (body.length > 1_000_000) return JSON.stringify({ error: 'Google API request body exceeds the 1 MB limit.' });
      }

      const response = await fetcher(url, {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      const responseText = await response.text();
      let payload: unknown;
      try {
        payload = responseText ? JSON.parse(responseText) : {};
      } catch {
        payload = responseText.slice(0, 40_000);
      }
      if (!response.ok) {
        const detail = typeof payload === 'object' && payload !== null
          ? (payload as { error?: { message?: unknown } }).error?.message
          : undefined;
        return JSON.stringify({
          error: typeof detail === 'string' ? detail : `Google API request failed (${response.status}).`,
          status: response.status,
          response: payload,
        });
      }
      return JSON.stringify(payload);
    },
  };
}

export const googleWorkspaceTool = createGoogleWorkspaceTool();
