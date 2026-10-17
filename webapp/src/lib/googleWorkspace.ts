export interface GoogleWorkspaceService {
  id: string;
  name: string;
  description: string;
  scopes: string[];
}

export interface GoogleWorkspaceItem {
  id: string;
  title: string;
  detail?: string;
  url?: string;
}

export const GOOGLE_WORKSPACE_SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://mail.google.com/',
  'https://www.googleapis.com/auth/gmail.settings.basic',
  'https://www.googleapis.com/auth/gmail.settings.sharing',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/contacts',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/presentations',
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/chat.messages',
  'https://www.googleapis.com/auth/chat.messages.create',
  'https://www.googleapis.com/auth/chat.messages.reactions',
  'https://www.googleapis.com/auth/chat.spaces',
  'https://www.googleapis.com/auth/chat.memberships',
  'https://www.googleapis.com/auth/chat.users.readstate',
  'https://www.googleapis.com/auth/forms.body',
  'https://www.googleapis.com/auth/forms.responses.readonly',
] as const;

export const GOOGLE_WORKSPACE_SERVICES: GoogleWorkspaceService[] = [
  { id: 'drive', name: 'Drive', description: 'Files and storage', scopes: ['https://www.googleapis.com/auth/drive'] },
  { id: 'gmail', name: 'Gmail', description: 'Read, manage, send mail, and manage settings', scopes: ['https://mail.google.com/', 'https://www.googleapis.com/auth/gmail.settings.basic', 'https://www.googleapis.com/auth/gmail.settings.sharing'] },
  { id: 'calendar', name: 'Calendar', description: 'Read and manage calendars', scopes: ['https://www.googleapis.com/auth/calendar'] },
  { id: 'contacts', name: 'Contacts', description: 'Read and manage contacts', scopes: ['https://www.googleapis.com/auth/contacts'] },
  { id: 'docs', name: 'Docs', description: 'Read and edit documents', scopes: ['https://www.googleapis.com/auth/documents'] },
  { id: 'sheets', name: 'Sheets', description: 'Read and edit spreadsheets', scopes: ['https://www.googleapis.com/auth/spreadsheets'] },
  { id: 'slides', name: 'Slides', description: 'Read and edit presentations', scopes: ['https://www.googleapis.com/auth/presentations'] },
  { id: 'tasks', name: 'Tasks', description: 'Read and manage tasks', scopes: ['https://www.googleapis.com/auth/tasks'] },
  { id: 'chat', name: 'Chat', description: 'Manage spaces, members, messages, reactions, and read state', scopes: ['https://www.googleapis.com/auth/chat.messages', 'https://www.googleapis.com/auth/chat.messages.create', 'https://www.googleapis.com/auth/chat.messages.reactions', 'https://www.googleapis.com/auth/chat.spaces', 'https://www.googleapis.com/auth/chat.memberships', 'https://www.googleapis.com/auth/chat.users.readstate'] },
  { id: 'forms', name: 'Forms', description: 'Read and edit Google Forms and read responses', scopes: ['https://www.googleapis.com/auth/forms.body', 'https://www.googleapis.com/auth/forms.responses.readonly'] },
];

type FetchLike = typeof fetch;
type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function asArray(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.map(asObject) : [];
}

function fieldText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function driveQuery(mimeType?: string, pageSize = 10): string {
  const params = new URLSearchParams({
    pageSize: String(pageSize),
    orderBy: 'modifiedTime desc',
    fields: 'files(id,name,mimeType,modifiedTime,webViewLink)',
    q: mimeType ? `trashed = false and mimeType = '${mimeType}'` : 'trashed = false',
  });
  return `drive/v3/files?${params}`;
}

async function getJson(path: string, accessToken: string, fetcher: FetchLike, host = 'www.googleapis.com'): Promise<JsonObject> {
  const response = await fetcher(`https://${host}/${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const root = asObject(payload);
    const error = asObject(root.error);
    throw new Error(fieldText(error.message) ?? `Google API request failed (${response.status}).`);
  }
  return asObject(payload);
}

function driveItems(payload: JsonObject): GoogleWorkspaceItem[] {
  return asArray(payload.files).flatMap(file => {
    const id = fieldText(file.id);
    const title = fieldText(file.name);
    if (!id || !title) return [];
    return [{
      id,
      title,
      detail: fieldText(file.modifiedTime),
      url: fieldText(file.webViewLink),
    }];
  });
}

function getService(id: string): GoogleWorkspaceService {
  const service = GOOGLE_WORKSPACE_SERVICES.find(candidate => candidate.id === id);
  if (!service) throw new Error(`Unsupported Google Workspace service: ${id}`);
  return service;
}

async function inspectDriveBackedService(
  serviceId: 'docs' | 'sheets' | 'slides' | 'forms',
  mimeType: string,
  accessToken: string,
  fetcher: FetchLike,
): Promise<GoogleWorkspaceItem[]> {
  const items = driveItems(await getJson(driveQuery(mimeType, 1), accessToken, fetcher));
  const firstItem = items[0];
  if (!firstItem) {
    throw new Error(`No accessible ${getService(serviceId).name} file was found to verify its API.`);
  }

  const id = encodeURIComponent(firstItem.id);
  const probes = {
    docs: [`v1/documents/${id}?fields=documentId,title`, 'docs.googleapis.com'],
    sheets: [`v4/spreadsheets/${id}?includeGridData=false&fields=spreadsheetId,properties.title`, 'sheets.googleapis.com'],
    slides: [`v1/presentations/${id}?fields=presentationId,title`, 'slides.googleapis.com'],
    forms: [`v1/forms/${id}?fields=formId,info.title`, 'forms.googleapis.com'],
  } as const;
  const [path, host] = probes[serviceId];
  await getJson(path, accessToken, fetcher, host);
  return items;
}

export async function inspectGoogleWorkspaceService(
  serviceId: string,
  accessToken: string,
  fetcher: FetchLike = fetch,
): Promise<GoogleWorkspaceItem[]> {
  if (!accessToken.trim()) throw new Error('Google did not return an access token. Sign in again and grant the requested access.');
  getService(serviceId);

  if (serviceId === 'drive') return driveItems(await getJson(driveQuery(), accessToken, fetcher));
  if (serviceId === 'docs') return inspectDriveBackedService(serviceId, 'application/vnd.google-apps.document', accessToken, fetcher);
  if (serviceId === 'sheets') return inspectDriveBackedService(serviceId, 'application/vnd.google-apps.spreadsheet', accessToken, fetcher);
  if (serviceId === 'slides') return inspectDriveBackedService(serviceId, 'application/vnd.google-apps.presentation', accessToken, fetcher);
  if (serviceId === 'forms') return inspectDriveBackedService(serviceId, 'application/vnd.google-apps.form', accessToken, fetcher);

  if (serviceId === 'gmail') {
    const list = await getJson('gmail/v1/users/me/messages?maxResults=8', accessToken, fetcher);
    const messages = asArray(list.messages);
    return Promise.all(messages.flatMap(message => {
      const id = fieldText(message.id);
      if (!id) return [];
      const params = new URLSearchParams({ format: 'metadata' });
      params.append('metadataHeaders', 'Subject');
      params.append('metadataHeaders', 'From');
      return [getJson(`gmail/v1/users/me/messages/${encodeURIComponent(id)}?${params}`, accessToken, fetcher).then(payload => {
        const headers = asArray(asObject(payload.payload).headers);
        const headerValue = (name: string) => fieldText(headers.find(header => fieldText(header.name)?.toLowerCase() === name.toLowerCase())?.value);
        return {
          id,
          title: headerValue('Subject') ?? '(No subject)',
          detail: headerValue('From'),
        };
      })];
    }));
  }

  if (serviceId === 'calendar') {
    const params = new URLSearchParams({
      maxResults: '10',
      orderBy: 'startTime',
      singleEvents: 'true',
      timeMin: new Date().toISOString(),
    });
    const payload = await getJson(`calendar/v3/calendars/primary/events?${params}`, accessToken, fetcher);
    return asArray(payload.items).flatMap(event => {
      const id = fieldText(event.id);
      const title = fieldText(event.summary);
      if (!id || !title) return [];
      const start = asObject(event.start);
      return [{ id, title, detail: fieldText(start.dateTime) ?? fieldText(start.date) }];
    });
  }

  if (serviceId === 'contacts') {
    const params = new URLSearchParams({ pageSize: '10', personFields: 'names,emailAddresses' });
    const payload = await getJson(`people/v1/people/me/connections?${params}`, accessToken, fetcher);
    return asArray(payload.connections).flatMap((person, index) => {
      const name = asArray(person.names)[0];
      const email = asArray(person.emailAddresses)[0];
      const title = fieldText(asObject(name).displayName);
      if (!title) return [];
      return [{ id: fieldText(person.resourceName) ?? `contact-${index}`, title, detail: fieldText(asObject(email).value) }];
    });
  }

  if (serviceId === 'tasks') {
    const payload = await getJson('tasks/v1/users/@me/lists?maxResults=10', accessToken, fetcher);
    return asArray(payload.items).flatMap(list => {
      const id = fieldText(list.id);
      const title = fieldText(list.title);
      return id && title ? [{ id, title }] : [];
    });
  }

  if (serviceId === 'chat') {
    const payload = await getJson('chat/v1/spaces?pageSize=10', accessToken, fetcher);
    return asArray(payload.spaces).flatMap(space => {
      const id = fieldText(space.name);
      const title = fieldText(space.displayName) ?? id;
      return id && title ? [{ id, title, detail: fieldText(space.type) }] : [];
    });
  }

  return [];
}
