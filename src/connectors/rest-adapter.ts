import type { IntegrationCredentials } from '../security/credential-vault.js';
import type {
  ConnectorAdapter,
  ConnectorCapability,
  ConnectorExecutionContext,
  ConnectorHealth,
  ConnectorManifest,
} from './types.js';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type JsonObject = Record<string, unknown>;
type FetchLike = typeof fetch;

interface RestRequest {
  method: HttpMethod;
  path: string;
  query?: Record<string, string | number | boolean>;
  body?: JsonObject;
}

interface RestOperation {
  capability: ConnectorCapability;
  buildRequest(input: Record<string, unknown>): RestRequest;
}

interface RestConnectorOptions {
  manifest: ConnectorManifest;
  baseUrl: string;
  probePath: string;
  tokenField?: string;
  tokenHeader?: string;
  tokenQuery?: string;
  headers?: Record<string, string>;
  fetcher?: FetchLike;
}

const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_REQUEST_BYTES = 1_000_000;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(input: Record<string, unknown>, key: string, maximum = 2_000): string {
  const value = input[key];
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new Error(`${key} must be a non-empty string of at most ${maximum} characters.`);
  }
  return value.trim();
}

function optionalInteger(input: Record<string, unknown>, key: string, fallback: number, minimum: number, maximum: number): number {
  const value = input[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${key} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[nested value omitted]';
  if (Array.isArray(value)) return value.slice(0, 200).map(item => redact(item, depth + 1));
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    /(?:secret|password|private.?key|api.?key|access.?token|refresh.?token|authorization)/i.test(key)
      ? '[redacted]'
      : redact(child, depth + 1),
  ]));
}

async function readLimitedResponse(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error(`Connector response exceeded the ${MAX_RESPONSE_BYTES} byte limit.`);
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error(`Connector response exceeded the ${MAX_RESPONSE_BYTES} byte limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

export class RestConnectorAdapter implements ConnectorAdapter {
  readonly manifest: ConnectorManifest;
  private readonly baseUrl: URL;
  private readonly probePath: string;
  private readonly tokenField: string;
  private readonly tokenHeader: string;
  private readonly tokenQuery?: string;
  private readonly headers: Record<string, string>;
  private readonly fetcher: FetchLike;
  private readonly operations = new Map<string, RestOperation>();

  constructor(options: RestConnectorOptions, operations: RestOperation[]) {
    this.manifest = options.manifest;
    this.baseUrl = new URL(options.baseUrl);
    this.probePath = options.probePath;
    this.tokenField = options.tokenField ?? 'token';
    this.tokenQuery = options.tokenQuery;
    this.tokenHeader = options.tokenQuery ? '' : options.tokenHeader ?? 'Authorization';
    this.headers = options.headers ?? {};
    this.fetcher = options.fetcher ?? fetch;
    for (const operation of operations) {
      if (this.operations.has(operation.capability.id)) {
        throw new Error(`Duplicate connector capability: ${this.manifest.id}/${operation.capability.id}`);
      }
      this.operations.set(operation.capability.id, operation);
    }
  }

  async health(credentials: IntegrationCredentials): Promise<ConnectorHealth> {
    const checkedAt = Date.now();
    try {
      await this.request({ method: 'GET', path: this.probePath }, credentials);
      return { state: 'connected', checkedAt };
    } catch (failure) {
      return {
        state: 'error',
        checkedAt,
        message: failure instanceof Error ? failure.message : String(failure),
      };
    }
  }

  async execute(
    capabilityId: string,
    input: Record<string, unknown>,
    credentials: IntegrationCredentials,
    context: ConnectorExecutionContext,
  ): Promise<unknown> {
    const operation = this.operations.get(capabilityId);
    if (!operation) throw new Error(`Unknown capability: ${this.manifest.id}/${capabilityId}`);
    return this.request(operation.buildRequest(input), credentials, context.signal);
  }

  private async request(
    request: RestRequest,
    credentials: IntegrationCredentials,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
      throw new Error('Unsupported connector HTTP method.');
    }
    if (typeof request.path !== 'string' || !request.path.startsWith('/') || request.path.startsWith('//')
      || request.path.includes('\\') || request.path.split('/').some(part => part === '.' || part === '..')
      || /[\r\n#]/.test(request.path)) {
      throw new Error('Connector API paths must be relative absolute paths without traversal or fragments.');
    }
    const basePath = this.baseUrl.pathname.replace(/\/+$/, '');
    const url = new URL(`${basePath}${request.path}`, this.baseUrl.origin);
    if (url.origin !== this.baseUrl.origin || url.username || url.password) {
      throw new Error('Connector requests must stay on the configured service origin.');
    }
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (!/^[A-Za-z$][A-Za-z0-9$_.-]*$/.test(key)
        || !['string', 'number', 'boolean'].includes(typeof value)) {
        throw new Error(`Invalid connector query parameter: ${key}`);
      }
      url.searchParams.set(key, String(value));
    }

    const body = request.body === undefined ? undefined : JSON.stringify(request.body);
    if (body && Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
      throw new Error(`Connector request body exceeded the ${MAX_REQUEST_BYTES} byte limit.`);
    }
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...this.headers,
    };
    const token = credentials[this.tokenField]?.trim();
    if (this.tokenQuery) {
      if (!token) throw new Error(`Connector credentials are missing ${this.tokenField}.`);
      url.searchParams.set(this.tokenQuery, token);
    }
    if (this.tokenHeader === 'Authorization') {
      if (!token) throw new Error(`Connector credentials are missing ${this.tokenField}.`);
      headers.Authorization = `Bearer ${token}`;
    } else if (this.tokenHeader) {
      if (!token) throw new Error(`Connector credentials are missing ${this.tokenField}.`);
      headers[this.tokenHeader] = token;
    }
    if (body) headers['Content-Type'] = 'application/json';

    const response = await this.fetcher(url, {
      method: request.method,
      headers,
      redirect: 'error',
      signal: signal ?? AbortSignal.timeout(15_000),
      ...(body ? { body } : {}),
    });
    const text = await readLimitedResponse(response);
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) as unknown : {};
    } catch {
      payload = text.slice(0, 40_000);
    }
    if (!response.ok) {
      throw new Error(`Connector request failed with HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}.`);
    }
    if (isObject(payload) && payload.ok === false) {
      const detail = typeof payload.error === 'string' ? payload.error : 'The provider rejected the connector request.';
      throw new Error(detail.slice(0, 500));
    }
    return redact(payload);
  }
}

export function connectorInputObject(input: Record<string, unknown>, key: string): JsonObject {
  const value = input[key];
  if (!isObject(value)) throw new Error(`${key} must be a JSON object.`);
  return value;
}

export { optionalInteger, requiredString };
