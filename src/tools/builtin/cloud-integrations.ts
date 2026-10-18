// Symbiote — Cloud Integration Tools
// Placeholder stubs for Azure, OCI, n8n, Kaggle cloud APIs.
// These are registered as tools but delegate to the actual cloud SDK clients.

import type { ToolDefinition } from '../types.js';
import type { CredentialVault } from '../../security/credential-vault.js';

export function createCloudIntegrationTools(credentialVault: CredentialVault): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    {
      name: 'azure_cloud',
      description: 'Use Azure Resource Manager REST APIs for the configured subscription. Supports Azure GPU VM and Azure ML compute provisioning and management.',
      parameters: {
        type: 'object',
        properties: {
          method: { type: 'string', description: 'HTTP method.', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
          path: { type: 'string', description: 'Provider API path scoped to the configured subscription.' },
          query: { type: 'object', description: 'Optional API query parameters.' },
          body: { type: 'object', description: 'Optional JSON body.' },
        },
        required: ['method', 'path'],
      },
      idempotency: {
        class: 'external',
        externalSystem: 'Azure Resource Manager API',
        idempotencyKey: (input) => `azure_cloud:${String(input.method ?? '')}:${String(input.path ?? '')}:${JSON.stringify(input.query ?? {})}:${JSON.stringify(input.body ?? {})}`,
      },
      async execute(input) {
        return JSON.stringify({ error: 'Azure cloud tool requires credential vault configuration.' });
      },
    },
    {
      name: 'oci_cloud',
      description: 'Use signed REST requests across regional OCI service endpoints, including Compute, networking, Object Storage, and Resource Manager.',
      parameters: {
        type: 'object',
        properties: {
          method: { type: 'string', description: 'HTTP method.', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
          path: { type: 'string', description: 'Provider API path.' },
          service: { type: 'string', description: 'OCI service API endpoint label or alias.' },
          query: { type: 'object', description: 'Optional API query parameters.' },
          body: { type: 'object', description: 'Optional JSON body.' },
        },
        required: ['method', 'path', 'service'],
      },
      idempotency: {
        class: 'external',
        externalSystem: 'OCI cloud API',
        idempotencyKey: (input) => `oci_cloud:${String(input.method ?? '')}:${String(input.path ?? '')}:${String(input.service ?? '')}:${JSON.stringify(input.query ?? {})}:${JSON.stringify(input.body ?? {})}`,
      },
      async execute(input) {
        return JSON.stringify({ error: 'OCI cloud tool requires credential vault configuration.' });
      },
    },
    {
      name: 'n8n_cloud',
      description: 'Use the configured n8n Cloud public API to inspect, create, update, activate, deactivate, and execute workflows.',
      parameters: {
        type: 'object',
        properties: {
          method: { type: 'string', description: 'HTTP method.', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
          path: { type: 'string', description: 'Provider API path relative to /api/v1.' },
          query: { type: 'object', description: 'Optional API query parameters.' },
          body: { type: 'object', description: 'Optional JSON body.' },
        },
        required: ['method', 'path'],
      },
      idempotency: {
        class: 'external',
        externalSystem: 'n8n Cloud API',
        idempotencyKey: (input) => `n8n_cloud:${String(input.method ?? '')}:${String(input.path ?? '')}:${JSON.stringify(input.query ?? {})}:${JSON.stringify(input.body ?? {})}`,
      },
      async execute(input) {
        return JSON.stringify({ error: 'n8n cloud tool requires credential vault configuration.' });
      },
    },
    {
      name: 'kaggle_cloud',
      description: 'Use Kaggle APIs to discover datasets and kernels and manage notebook jobs.',
      parameters: {
        type: 'object',
        properties: {
          method: { type: 'string', description: 'HTTP method.', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
          path: { type: 'string', description: 'Provider API path beginning /api/v1/.' },
          query: { type: 'object', description: 'Optional API query parameters.' },
          body: { type: 'object', description: 'Optional JSON body.' },
        },
        required: ['method', 'path'],
      },
      idempotency: {
        class: 'external',
        externalSystem: 'Kaggle API',
        idempotencyKey: (input) => `kaggle_cloud:${String(input.method ?? '')}:${String(input.path ?? '')}:${JSON.stringify(input.query ?? {})}:${JSON.stringify(input.body ?? {})}`,
      },
      async execute(input) {
        return JSON.stringify({ error: 'Kaggle cloud tool requires credential vault configuration.' });
      },
    },
  ];
  return tools;
}
