import * as crypto from 'node:crypto';
import type { CredentialVault, IntegrationCredentials, IntegrationProvider } from '../../security/credential-vault.js';
import type { ToolDefinition } from '../types.js';

type FetchLike = typeof fetch;
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type JsonObject = Record<string, unknown>;

const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const DEFAULT_N8N_BASE_URL = 'http://127.0.0.1:5678/api/v1';
const OCI_SERVICES = {
  compute: 'iaas',
  networking: 'iaas',
  blockstorage: 'iaas',
  loadbalancer: 'iaas',
  autoscaling: 'iaas',
  identity: 'identity',
  objectstorage: 'objectstorage',
  resourcemanager: 'resourcemanager',
  database: 'database',
  containerengine: 'containerengine',
  functions: 'functions',
  logging: 'logging',
  monitoring: 'monitoring',
  vault: 'kms',
  keymanagement: 'kms',
  streaming: 'streaming',
} as const;
type OciService = string;

const TOOL_DOCS: Record<IntegrationProvider, string> = {
  azure: 'Use Azure Resource Manager REST APIs for the configured subscription. Supports Azure GPU VM and Azure ML compute provisioning and management. POST, PUT, PATCH, and DELETE actions apply immediately and can incur charges.',
  oci: 'Use signed REST requests across regional OCI service endpoints, including Compute, networking, Object Storage, and Resource Manager. Supports GPU instance and cluster provisioning and management. POST, PUT, PATCH, and DELETE actions apply immediately and can incur charges.',
  n8n: 'Use the local n8n API by default for full management of the instance, including workflows, credentials, and executions. A saved API key and endpoint in Integrations explicitly override the local connection. Actions are applied immediately.',
  kaggle: 'Use Kaggle APIs to discover datasets and kernels and manage notebook jobs where the Kaggle API supports it. Kaggle GPU usage is quota-limited by Kaggle and is not an Azure/OCI GPU cluster.',
};

function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function requiredString(credentials: IntegrationCredentials, key: string, provider: string): string {
  const value = credentials[key]?.trim();
  if (!value) throw new Error(`${provider} is not configured: missing ${key}. Add credentials in Integrations.`);
  return value;
}

function safeFailureMessage(failure: unknown, credentials: IntegrationCredentials): string {
  let message = failure instanceof Error ? failure.message : String(failure);
  for (const [key, value] of Object.entries(credentials)) {
    if (/(?:secret|password|private.?key|api.?key|token)/i.test(key) && value.length > 0) {
      message = message.replaceAll(value, '[redacted]');
    }
  }
  return message;
}

function validatePath(value: unknown, prefix?: string): string {
  if (typeof value !== 'string' || value.length < 2 || value.length > 4_000
    || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')
    || value.split('/').some(segment => segment === '.' || segment === '..')
    || /[\r\n#]/.test(value)) {
    throw new Error('API path must be an absolute path without traversal, fragment, or newline characters.');
  }
  if (prefix && !value.startsWith(prefix)) throw new Error(`API path must start with ${prefix}.`);
  return value;
}

function buildUrl(base: string, apiPath: string, query: unknown): URL {
  const url = new URL(apiPath, base);
  const parameters = asObject(query);
  for (const [key, value] of Object.entries(parameters)) {
    if (!/^[A-Za-z$][A-Za-z0-9$_.-]*$/.test(key)
      || !['string', 'number', 'boolean'].includes(typeof value)) {
      throw new Error(`Invalid API query parameter: ${key}`);
    }
    url.searchParams.set(key, String(value));
  }
  return url;
}

function requestBody(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('API request body must be a JSON object.');
  }
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > 1_000_000) throw new Error('API request body exceeds the 1 MB limit.');
  return encoded;
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[nested value omitted]';
  if (Array.isArray(value)) return value.slice(0, 200).map(item => redact(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    /(?:secret|password|private.?key|api.?key|access.?token|refresh.?token|client.?secret)/i.test(key)
      ? '[redacted]'
      : redact(child, depth + 1),
  ]));
}

async function readResponse(response: Response, redactPayload = true): Promise<unknown> {
  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = text.slice(0, 40_000);
  }
  if (!response.ok) {
    const root = asObject(payload);
    const details = typeof root.error === 'string'
      ? root.error
      : typeof asObject(root.error).message === 'string'
        ? asObject(root.error).message as string
        : typeof root.message === 'string' ? root.message : `Provider API request failed (${response.status}).`;
    throw new Error(`${details} [HTTP ${response.status}]`);
  }
  return redactPayload ? redact(payload) : payload;
}

function assertMethod(value: unknown): HttpMethod {
  const method = typeof value === 'string' ? value.toUpperCase() : '';
  if (!METHODS.includes(method as HttpMethod)) throw new Error('Unsupported HTTP method.');
  return method as HttpMethod;
}

function azureTokenEndpoint(tenantId: string): string {
  if (!/^[A-Za-z0-9.-]+$/.test(tenantId)) throw new Error('Azure tenantId has invalid characters.');
  return `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
}

async function getAzureAccessToken(credentials: IntegrationCredentials, fetcher: FetchLike): Promise<string> {
  const tenantId = requiredString(credentials, 'tenantId', 'Azure');
  const clientId = requiredString(credentials, 'clientId', 'Azure');
  const clientSecret = requiredString(credentials, 'clientSecret', 'Azure');
  const form = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://management.azure.com/.default',
    grant_type: 'client_credentials',
  });
  const response = await fetcher(azureTokenEndpoint(tenantId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form,
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  const token = asObject(await readResponse(response, false)).access_token;
  if (typeof token !== 'string' || !token) throw new Error('Azure token endpoint returned no access token.');
  return token;
}

async function callAzure(
  credentials: IntegrationCredentials,
  method: HttpMethod,
  apiPath: string,
  query: unknown,
  body: unknown,
  fetcher: FetchLike,
): Promise<unknown> {
  const subscriptionId = requiredString(credentials, 'subscriptionId', 'Azure');
  const normalizedPath = validatePath(apiPath);
  if (!normalizedPath.startsWith('/subscriptions/')) {
    throw new Error('Azure Resource Manager paths must stay within the configured subscription.');
  }
  const url = buildUrl(`https://management.azure.com`, normalizedPath, query);
  if (!url.searchParams.has('api-version')) throw new Error('Azure Resource Manager requests require an api-version query parameter.');
  if (!normalizedPath.startsWith(`/subscriptions/${encodeURIComponent(subscriptionId)}/`)) {
    throw new Error('Azure path must stay within the configured subscription.');
  }
  const token = await getAzureAccessToken(credentials, fetcher);
  const encodedBody = requestBody(body);
  const response = await fetcher(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(encodedBody ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(encodedBody ? { body: encodedBody } : {}),
    redirect: 'error',
    signal: AbortSignal.timeout(60_000),
  });
  return readResponse(response);
}

function ociHost(region: string, service: OciService): string {
  if (!/^[a-z0-9-]{3,32}$/.test(region)) throw new Error('OCI region must be a valid region identifier.');
  const serviceHost = OCI_SERVICES[service as keyof typeof OCI_SERVICES] ?? service;
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(serviceHost)) throw new Error('OCI service must be a valid Oracle Cloud API service hostname label.');
  return `${serviceHost}.${region}.oraclecloud.com`;
}

function signOciRequest(
  credentials: IntegrationCredentials,
  host: string,
  method: HttpMethod,
  url: URL,
  body: string | undefined,
): Record<string, string> {
  const tenancy = requiredString(credentials, 'tenancyOcid', 'Oracle Cloud');
  const user = requiredString(credentials, 'userOcid', 'Oracle Cloud');
  const fingerprint = requiredString(credentials, 'fingerprint', 'Oracle Cloud');
  const privateKey = requiredString(credentials, 'privateKey', 'Oracle Cloud');
  const date = new Date().toUTCString();
  const headers: Record<string, string> = { host, date, Accept: 'application/json' };
  let signedHeaders = '(request-target) host date';
  const signingParts = [`(request-target): ${method.toLowerCase()} ${url.pathname}${url.search}`, `host: ${host}`, `date: ${date}`];
  if (body !== undefined) {
    const bodyBuffer = Buffer.from(body);
    const digest = crypto.createHash('sha256').update(bodyBuffer).digest('base64');
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(bodyBuffer.byteLength);
    headers['x-content-sha256'] = digest;
    signedHeaders = '(request-target) host date content-length content-type x-content-sha256';
    signingParts.push(`content-length: ${bodyBuffer.byteLength}`, 'content-type: application/json', `x-content-sha256: ${digest}`);
  }
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingParts.join('\n'));
  const signature = signer.sign(privateKey, 'base64');
  headers.Authorization = `Signature version="1",keyId="${tenancy}/${user}/${fingerprint}",algorithm="rsa-sha256",headers="${signedHeaders}",signature="${signature}"`;
  return headers;
}

async function callOci(
  credentials: IntegrationCredentials,
  serviceValue: unknown,
  method: HttpMethod,
  apiPath: string,
  query: unknown,
  body: unknown,
  fetcher: FetchLike,
): Promise<unknown> {
  if (typeof serviceValue !== 'string') {
    throw new Error('OCI service must be a service name or Oracle Cloud API endpoint label.');
  }
  const service = serviceValue;
  const region = requiredString(credentials, 'region', 'Oracle Cloud');
  const host = ociHost(region, service);
  const url = buildUrl(`https://${host}`, validatePath(apiPath), query);
  const encodedBody = requestBody(body);
  const response = await fetcher(url, {
    method,
    headers: signOciRequest(credentials, host, method, url, encodedBody),
    ...(encodedBody ? { body: encodedBody } : {}),
    redirect: 'error',
    signal: AbortSignal.timeout(60_000),
  });
  return readResponse(response);
}

function n8nBaseUrl(credentials: IntegrationCredentials): URL {
  const base = requiredString(credentials, 'baseUrl', 'n8n').replace(/\/+$/, '');
  const url = new URL(base);
  const hostname = url.hostname.toLowerCase();
  const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback))
    || url.username || url.password || url.search || url.hash) {
    throw new Error('n8n baseUrl must use HTTPS, or HTTP on a loopback host, without credentials, query, or fragment.');
  }
  if (url.pathname.replace(/\/+$/, '') !== '/api/v1') {
    throw new Error('n8n baseUrl path must be exactly /api/v1.');
  }
  url.pathname = '/api/v1';
  return url;
}

function localN8nCredentials(): IntegrationCredentials | null {
  const apiKey = process.env.N8N_API_KEY?.trim();
  if (!apiKey) return null;
  const baseUrl = process.env.N8N_BASE_URL?.trim() || DEFAULT_N8N_BASE_URL;
  const credentials = { baseUrl, apiKey };
  n8nBaseUrl(credentials);
  return credentials;
}

function getN8nCredentials(vault: CredentialVault): IntegrationCredentials | null {
  const configured = vault.get('n8n');
  if (configured) return configured;
  return localN8nCredentials();
}

async function callN8n(
  credentials: IntegrationCredentials,
  method: HttpMethod,
  apiPath: string,
  query: unknown,
  body: unknown,
  fetcher: FetchLike,
): Promise<unknown> {
  const base = n8nBaseUrl(credentials);
  const apiPathValue = validatePath(apiPath, '/');
  if (apiPathValue.includes('/../')) throw new Error('n8n API path traversal is not allowed.');
  const apiRoot = `${base.origin}${base.pathname.replace(/\/+$/, '')}/`;
  const url = buildUrl(apiRoot, apiPathValue.replace(/^\/+/, ''), query);
  if (url.origin !== base.origin || !url.pathname.startsWith(`${base.pathname.replace(/\/+$/, '')}/`)) {
    throw new Error('n8n requests must stay within the configured API root.');
  }
  const encodedBody = requestBody(body);
  const response = await fetcher(url, {
    method,
    headers: {
      'X-N8N-API-KEY': requiredString(credentials, 'apiKey', 'n8n'),
      Accept: 'application/json',
      ...(encodedBody ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(encodedBody ? { body: encodedBody } : {}),
    redirect: 'error',
    signal: AbortSignal.timeout(60_000),
  });
  return readResponse(response);
}

async function callKaggle(
  credentials: IntegrationCredentials,
  method: HttpMethod,
  apiPath: string,
  query: unknown,
  body: unknown,
  fetcher: FetchLike,
): Promise<unknown> {
  const apiToken = requiredString(credentials, 'apiToken', 'Kaggle');
  const url = buildUrl('https://www.kaggle.com', validatePath(apiPath, '/api/v1/'), query);
  const encodedBody = requestBody(body);
  const username = credentials.username?.trim();
  const authorization = username
    ? `Basic ${Buffer.from(`${username}:${apiToken}`).toString('base64')}`
    : `Bearer ${apiToken}`;
  const response = await fetcher(url, {
    method,
    headers: {
      Authorization: authorization,
      Accept: 'application/json',
      ...(encodedBody ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(encodedBody ? { body: encodedBody } : {}),
    redirect: 'error',
    signal: AbortSignal.timeout(60_000),
  });
  return readResponse(response);
}

function crc32(buffer: Buffer): number {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  }
  return (value ^ 0xffffffff) >>> 0;
}

function makeStoredZip(files: Array<{ name: string; content: string }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const data = Buffer.from(file.content, 'utf8');
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function asStringList(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50
    || value.some(item => typeof item !== 'string' || item.length > 300 || !item.trim())) {
    throw new Error(`${name} must be an array of at most 50 non-empty strings.`);
  }
  return value as string[];
}

async function pushKaggleKernel(
  credentials: IntegrationCredentials,
  input: Record<string, unknown>,
  fetcher: FetchLike,
): Promise<unknown> {
  const metadataInput = asObject(input.metadata);
  const id = metadataInput.id;
  const title = metadataInput.title;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{2,100}\/[A-Za-z0-9_-]{2,100}$/.test(id)) {
    throw new Error('Kaggle kernel metadata.id must be a username/slug pair.');
  }
  if (typeof title !== 'string' || !title.trim() || title.length > 100) {
    throw new Error('Kaggle kernel metadata.title must contain 1–100 characters.');
  }
  const source = input.source;
  const notebook = input.notebook;
  if (source !== undefined && typeof source !== 'string') {
    throw new Error('source must be a Python source string.');
  }
  if (typeof source === 'string' && !source.trim()) throw new Error('source must contain Python code.');
  if ((source === undefined) === (notebook === undefined)) {
    throw new Error('Provide exactly one of source (Python code) or notebook (Jupyter notebook JSON).');
  }
  let notebookText: string;
  if (typeof source === 'string' && source.trim()) {
    notebookText = JSON.stringify({
      cells: [{
        cell_type: 'code',
        execution_count: null,
        metadata: {},
        outputs: [],
        source: source.split(/(?<=\n)/),
      }],
      metadata: {
        kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
        language_info: { name: 'python' },
      },
      nbformat: 4,
      nbformat_minor: 5,
    });
  } else {
    if (!notebook || typeof notebook !== 'object' || Array.isArray(notebook)) {
      throw new Error('notebook must be a valid Jupyter notebook object.');
    }
    notebookText = JSON.stringify(notebook);
    const parsedNotebook = asObject(notebook);
    if (parsedNotebook.nbformat !== 4 || !Array.isArray(parsedNotebook.cells)) {
      throw new Error('notebook must use nbformat 4 and contain a cells array.');
    }
  }
  if (Buffer.byteLength(notebookText) > 1_000_000) throw new Error('Kaggle notebook source exceeds the 1 MB limit.');
  const enableGpu = metadataInput.enableGpu ?? false;
  const enableInternet = metadataInput.enableInternet ?? false;
  const isPrivate = metadataInput.isPrivate ?? true;
  if (typeof enableGpu !== 'boolean' || typeof enableInternet !== 'boolean' || typeof isPrivate !== 'boolean') {
    throw new Error('enableGpu, enableInternet, and isPrivate must be boolean metadata values.');
  }
  const machineShape = metadataInput.machineShape ?? '';
  if (typeof machineShape !== 'string' || machineShape.length > 80) {
    throw new Error('machineShape must be a string of at most 80 characters.');
  }
  const metadata = {
    id,
    title: title.trim(),
    code_file: 'main.ipynb',
    language: 'python',
    kernel_type: 'notebook',
    is_private: String(isPrivate),
    enable_gpu: String(enableGpu),
    enable_internet: String(enableInternet),
    machine_shape: machineShape,
    dataset_sources: asStringList(metadataInput.datasetSources, 'datasetSources'),
    competition_sources: asStringList(metadataInput.competitionSources, 'competitionSources'),
    kernel_sources: asStringList(metadataInput.kernelSources, 'kernelSources'),
    model_sources: asStringList(metadataInput.modelSources, 'modelSources'),
  };
  const archive = makeStoredZip([
    { name: 'kernel-metadata.json', content: JSON.stringify(metadata) },
    { name: 'main.ipynb', content: notebookText },
  ]);
  const form = new FormData();
  form.append('metadata', JSON.stringify(metadata));
  form.append('file', new Blob([new Uint8Array(archive)], { type: 'application/zip' }), 'kernel.zip');
  const username = requiredString(credentials, 'username', 'Kaggle');
  const apiToken = requiredString(credentials, 'apiToken', 'Kaggle');
  const authorization = Buffer.from(`${username}:${apiToken}`).toString('base64');
  const response = await fetcher('https://www.kaggle.com/api/v1/kernels/push', {
    method: 'POST',
    headers: { Authorization: `Basic ${authorization}`, Accept: 'application/json' },
    body: form,
    redirect: 'error',
    signal: AbortSignal.timeout(120_000),
  });
  return readResponse(response);
}

export function createCloudIntegrationTool(
  provider: IntegrationProvider,
  vault: CredentialVault,
  fetcher: FetchLike = fetch,
): ToolDefinition {
  return {
    name: `${provider}_cloud`,
    description: `${TOOL_DOCS[provider]} Credentials are kept in Symbiote's encrypted local vault and never appear in tool inputs or outputs.`,
    parameters: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: METHODS, description: 'HTTP method; destructive and provisioning operations execute immediately.' },
        path: { type: 'string', description: 'Provider API path. Azure paths must be scoped to the configured subscription; n8n paths are relative to /api/v1; Kaggle paths begin /api/v1/.' },
        service: { type: 'string', description: `OCI service API endpoint label or alias (${Object.keys(OCI_SERVICES).join(', ')}); requests are confined to the region-specific oraclecloud.com domain.` },
        query: { type: 'object', description: 'Optional API query parameters.' },
        body: { type: 'object', description: 'Optional JSON body. Request body size is limited to 1 MB.' },
      },
      required: ['method', 'path', ...(provider === 'oci' ? ['service'] : [])],
    },
    idempotency: {
      class: 'external',
      externalSystem: `${provider} cloud API`,
      idempotencyKey: input => `${provider}_cloud:${String(input.method ?? '')}:${String(input.path ?? '')}:${String(input.service ?? '')}:${JSON.stringify(input.query ?? {})}:${JSON.stringify(input.body ?? {})}`,
    },
    async execute(input) {
      let credentials: IntegrationCredentials | null = null;
      try {
        credentials = provider === 'n8n' ? getN8nCredentials(vault) : vault.get(provider);
        if (!credentials) {
          const guidance = provider === 'n8n'
            ? 'Set N8N_API_KEY in Symbiote .env or configure an explicit n8n endpoint and API key in Integrations.'
            : 'Add its credentials in Integrations first.';
          return JSON.stringify({ error: `${provider} is not configured. ${guidance}` });
        }
        const method = assertMethod(input.method);
        const apiPath = validatePath(input.path, provider === 'kaggle' ? '/api/v1/' : undefined);
        const result = provider === 'azure'
          ? await callAzure(credentials, method, apiPath, input.query, input.body, fetcher)
          : provider === 'oci'
            ? await callOci(credentials, input.service, method, apiPath, input.query, input.body, fetcher)
            : provider === 'n8n'
              ? await callN8n(credentials, method, apiPath, input.query, input.body, fetcher)
              : await callKaggle(credentials, method, apiPath, input.query, input.body, fetcher);
        return JSON.stringify(result);
      } catch (failure) {
        return JSON.stringify({ error: safeFailureMessage(failure, credentials ?? {}) });
      }
    },
  };
}

export function createCloudIntegrationTools(vault: CredentialVault, fetcher: FetchLike = fetch): ToolDefinition[] {
  const tools = (['azure', 'oci', 'n8n', 'kaggle'] as const).map(provider => createCloudIntegrationTool(provider, vault, fetcher));
  tools.push({
    name: 'kaggle_kernel_push',
    description: 'Upload and run a Python notebook on Kaggle; GPU/accelerator use is optional. This submits code remotely and consumes Kaggle quota; use isPrivate=true by default and verify GPU and dataset limits before running.',
    parameters: {
      type: 'object',
      properties: {
        metadata: {
          type: 'object',
          description: 'Notebook settings: id (username/slug), title, enableGpu, enableInternet, isPrivate, machineShape, datasetSources, competitionSources, kernelSources, modelSources.',
        },
        source: { type: 'string', description: 'Python source code for one notebook code cell. Provide this or notebook, not both.' },
        notebook: { type: 'object', description: 'A complete nbformat 4 notebook object. Provide this or source, not both.' },
      },
      required: ['metadata'],
    },
    idempotency: {
      class: 'external',
      externalSystem: 'Kaggle API',
      idempotencyKey: input => {
        const payload = JSON.stringify(input);
        if (payload === undefined) throw new Error('Kaggle job input cannot be serialized.');
        return `kaggle_kernel_push:${crypto.createHash('sha256').update(payload).digest('hex')}`;
      },
    },
    async execute(input) {
      let credentials: IntegrationCredentials | null = null;
      try {
        credentials = vault.get('kaggle');
        if (!credentials) return JSON.stringify({ error: 'Kaggle is not configured. Add its credentials in Integrations first.' });
        return JSON.stringify(await pushKaggleKernel(credentials, input, fetcher));
      } catch (failure) {
        return JSON.stringify({ error: safeFailureMessage(failure, credentials ?? {}) });
      }
    },
  });
  return tools;
}

export async function testCloudIntegration(
  provider: IntegrationProvider,
  vault: CredentialVault,
  fetcher: FetchLike = fetch,
): Promise<{ ok: true }> {
  const credentials = provider === 'n8n' ? getN8nCredentials(vault) : vault.get(provider);
  if (!credentials) throw new Error(`${provider} is not configured.`);
  try {
    if (provider === 'azure') {
      const subscriptionId = encodeURIComponent(requiredString(credentials, 'subscriptionId', 'Azure'));
      await callAzure(credentials, 'GET', `/subscriptions/${subscriptionId}/resourcegroups`, { 'api-version': '2021-04-01', '$top': 1 }, undefined, fetcher);
    } else if (provider === 'oci') {
      const tenancyOcid = encodeURIComponent(requiredString(credentials, 'tenancyOcid', 'Oracle Cloud'));
      await callOci(credentials, 'identity', 'GET', `/20160918/tenancies/${tenancyOcid}`, undefined, undefined, fetcher);
    } else if (provider === 'n8n') {
      await callN8n(credentials, 'GET', '/workflows', { limit: 1 }, undefined, fetcher);
    } else {
      await callKaggle(credentials, 'GET', '/api/v1/datasets/list', { page: 1, pageSize: 1 }, undefined, fetcher);
    }
  } catch (failure) {
    throw new Error(safeFailureMessage(failure, credentials), { cause: failure });
  }
  return { ok: true };
}

export function integrationCredentialStatus(vault: CredentialVault): Record<IntegrationProvider, boolean> {
  return {
    azure: vault.has('azure'),
    oci: vault.has('oci'),
    n8n: vault.has('n8n') || Boolean(process.env.N8N_API_KEY?.trim()),
    kaggle: vault.has('kaggle'),
  };
}

export function validateIntegrationCredentials(
  provider: IntegrationProvider,
  input: unknown,
  existing: IntegrationCredentials | null,
): IntegrationCredentials {
  const body = asObject(input);
  const fields: Record<IntegrationProvider, string[]> = {
    azure: ['tenantId', 'clientId', 'clientSecret', 'subscriptionId'],
    oci: ['tenancyOcid', 'userOcid', 'fingerprint', 'privateKey', 'region'],
    n8n: ['baseUrl', 'apiKey'],
    kaggle: ['apiToken'],
  };
  const allowedFields: Record<IntegrationProvider, string[]> = {
    ...fields,
    kaggle: ['username', 'apiToken'],
  };
  const result = { ...(existing ?? {}) };
  for (const field of allowedFields[provider]) {
    const value = body[field];
    if (value !== undefined) {
      if (typeof value !== 'string') throw new Error(`${field} must be a string.`);
      if (value.length > 64_000) throw new Error(`${field} exceeds the 64 KB limit.`);
      if (value.length > 0) result[field] = value;
    }
  }
  const missing = fields[provider].filter(field => !result[field]?.trim());
  if (missing.length) throw new Error(`Missing required ${provider} credential fields: ${missing.join(', ')}.`);
  if (provider === 'n8n') n8nBaseUrl(result);
  if (provider === 'azure') azureTokenEndpoint(result.tenantId);
  if (provider === 'oci') {
    ociHost(result.region, 'identity');
    try {
      crypto.createPrivateKey(result.privateKey);
    } catch (failure) {
      throw new Error('OCI privateKey must contain a valid PEM private key.', { cause: failure });
    }
  }
  return result;
}
