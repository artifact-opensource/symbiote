import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CredentialVault } from '../security/credential-vault.js';
import { createCloudIntegrationTool, createCloudIntegrationTools, validateIntegrationCredentials } from '../tools/builtin/cloud-integrations.js';

function withVault(run: (vault: CredentialVault) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'symbiote-cloud-integration-'));
  const vault = new CredentialVault({
    adminEnvPath: path.join(directory, '.admin', '.env'),
    vaultPath: path.join(directory, 'vault', 'integrations.enc'),
  });
  return run(vault).finally(() => rmSync(directory, { recursive: true, force: true }));
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

test('Azure requests obtain a token and stay inside the configured subscription', async () => withVault(async vault => {
  vault.set('azure', {
    tenantId: 'tenant-id',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    subscriptionId: 'subscription-id',
  });
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input.toString());
    calls.push({ url, init });
    return url.hostname === 'login.microsoftonline.com'
      ? response({ access_token: 'access-token' })
      : response({ value: [{ name: 'group' }] });
  };
  const tool = createCloudIntegrationTool('azure', vault, fetcher);
  const result = JSON.parse(await tool.execute({
    method: 'GET',
    path: '/subscriptions/subscription-id/resourcegroups',
    query: { 'api-version': '2021-04-01' },
  })) as { value: Array<{ name: string }> };
  assert.equal(result.value[0].name, 'group');
  assert.equal(calls[1].url.hostname, 'management.azure.com');
  assert.equal((calls[1].init?.headers as Record<string, string>).Authorization.endsWith('access-token'), true);

  const denied = JSON.parse(await tool.execute({
    method: 'DELETE',
    path: '/subscriptions/other-subscription/resourcegroups/protected',
    query: { 'api-version': '2021-04-01' },
  })) as { error: string };
  assert.match(denied.error, /configured subscription/);
  assert.equal(calls.length, 2);
}));

test('n8n requests remain inside the API root and redact secret response fields', async () => withVault(async vault => {
  vault.set('n8n', { baseUrl: 'https://sample.app.n8n.cloud/api/v1', apiKey: 'n8n-secret' });
  let requestUrl = '';
  let requestHeaders: HeadersInit | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    requestUrl = input.toString();
    requestHeaders = init?.headers;
    return response({ workflows: [{ name: 'sync', apiKey: 'reflected-secret' }] });
  };
  const result = JSON.parse(await createCloudIntegrationTool('n8n', vault, fetcher).execute({
    method: 'GET',
    path: '/workflows',
    query: { limit: 1 },
  })) as { workflows: Array<{ apiKey: string }> };
  assert.equal(requestUrl, 'https://sample.app.n8n.cloud/api/v1/workflows?limit=1');
  assert.equal((requestHeaders as Record<string, string>)['X-N8N-API-KEY'], 'n8n-secret');
  assert.equal(result.workflows[0].apiKey, '[redacted]');

  const failingTool = createCloudIntegrationTool('n8n', vault, async () => response({ error: { message: 'Rejected key n8n-secret' } }, 401));
  const failedResult = JSON.parse(await failingTool.execute({
    method: 'GET',
    path: '/workflows',
  })) as { error: string };
  assert.doesNotMatch(failedResult.error, /n8n-secret/);
  assert.match(failedResult.error, /\[redacted\]/);

  const invalid = JSON.parse(await createCloudIntegrationTool('n8n', vault, fetcher).execute({
    method: 'GET',
    path: '/../../workflows',
  })) as { error: string };
  assert.match(invalid.error, /traversal|absolute path/);
}));

test('OCI uses RSA request signing and Kaggle uses fixed-host Basic authentication', async () => withVault(async vault => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  vault.set('oci', {
    tenancyOcid: 'ocid1.tenancy.oc1..example',
    userOcid: 'ocid1.user.oc1..example',
    fingerprint: 'aa:bb:cc',
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    region: 'us-ashburn-1',
  });
  let ociHeaders: HeadersInit | undefined;
  let ociUrl = '';
  const ociFetcher: typeof fetch = async (input, init) => {
    ociUrl = input.toString();
    ociHeaders = init?.headers;
    return response({ ok: true });
  };
  await createCloudIntegrationTool('oci', vault, ociFetcher).execute({
    method: 'GET',
    service: 'identity',
    path: '/20160918/tenancies/ocid1.tenancy.oc1..example',
  });
  assert.equal(ociUrl, 'https://identity.us-ashburn-1.oraclecloud.com/20160918/tenancies/ocid1.tenancy.oc1..example');
  assert.match((ociHeaders as Record<string, string>).Authorization, /^Signature version="1".*algorithm="rsa-sha256"/);

  vault.set('kaggle', { username: 'researcher', apiToken: 'kaggle-token' });
  let kaggleUrl = '';
  let kaggleHeaders: HeadersInit | undefined;
  const kaggleFetcher: typeof fetch = async (input, init) => {
    kaggleUrl = input.toString();
    kaggleHeaders = init?.headers;
    return response({ datasets: [] });
  };
  await createCloudIntegrationTool('kaggle', vault, kaggleFetcher).execute({
    method: 'GET',
    path: '/api/v1/datasets/list',
  });
  assert.equal(kaggleUrl, 'https://www.kaggle.com/api/v1/datasets/list');
  assert.equal((kaggleHeaders as Record<string, string>).Authorization, `Basic ${Buffer.from('researcher:kaggle-token').toString('base64')}`);

  vault.delete('kaggle');
  vault.set('kaggle', { apiToken: 'current-api-token' });
  await createCloudIntegrationTool('kaggle', vault, kaggleFetcher).execute({
    method: 'GET',
    path: '/api/v1/datasets/list',
  });
  assert.match((kaggleHeaders as Record<string, string>).Authorization, /^Bearer /);
}));

test('Kaggle kernel tool uploads a private GPU notebook archive', async () => withVault(async vault => {
  vault.set('kaggle', { username: 'researcher', apiToken: 'kaggle-token' });
  let requestUrl = '';
  let requestBody: BodyInit | null | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    requestUrl = input.toString();
    requestBody = init?.body;
    return response({ status: 'submitted' });
  };
  const tool = createCloudIntegrationTools(vault, fetcher).find(candidate => candidate.name === 'kaggle_kernel_push');
  assert.ok(tool);
  const result = JSON.parse(await tool.execute({
    metadata: {
      id: 'researcher/transformer-training',
      title: 'Transformer Training',
      enableGpu: true,
      isPrivate: true,
      machineShape: 'NvidiaTeslaT4',
      datasetSources: ['researcher/text-dataset'],
    },
    source: 'print("training")\n',
  })) as { status: string };
  assert.equal(result.status, 'submitted');
  assert.equal(requestUrl, 'https://www.kaggle.com/api/v1/kernels/push');
  assert.ok(requestBody instanceof FormData);
  const metadata = JSON.parse(String(requestBody.get('metadata'))) as Record<string, unknown>;
  assert.equal(metadata.enable_gpu, 'true');
  assert.equal(metadata.is_private, 'true');
  const archive = requestBody.get('file');
  assert.ok(archive instanceof Blob);
  const bytes = Buffer.from(await archive.arrayBuffer());
  assert.equal(bytes.readUInt32LE(0), 0x04034b50);
  assert.ok(bytes.includes(Buffer.from('kernel-metadata.json')));
  assert.ok(bytes.includes(Buffer.from('training')));
}));

test('provider credential validation rejects malformed setup instead of storing it', async () => withVault(async vault => {
  assert.throws(() => validateIntegrationCredentials('azure', {}, null), /Missing required azure credential fields/);
  assert.throws(() => validateIntegrationCredentials('n8n', {
    baseUrl: 'http://127.0.0.1/api/v1',
    apiKey: 'secret',
  }, null), /n8n\.cloud HTTPS host/);
  assert.throws(() => validateIntegrationCredentials('oci', {
    tenancyOcid: 'tenancy',
    userOcid: 'user',
    fingerprint: 'fingerprint',
    region: 'us-ashburn-1',
    privateKey: 'not-a-key',
  }, null), /valid PEM private key/);
  assert.equal(vault.has('azure'), false);
}));
