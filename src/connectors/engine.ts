import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { appPath } from '../runtime/platform.js';
import type { CredentialVault, IntegrationCredentials } from '../security/credential-vault.js';
import type { ToolDefinition } from '../tools/types.js';
import type {
  ConnectorActivity,
  ConnectorAdapter,
  ConnectorCatalogEntry,
  ConnectorExecutionContext,
  ConnectorHealth,
  ConnectorManifest,
  ConnectorPermission,
} from './types.js';

interface ConnectorState {
  version: 1;
  connectedConnectorIds: string[];
  grants: Record<string, Record<string, string[]>>;
  activity: ConnectorActivity[];
}

export interface ConnectorEngineOptions {
  vault: CredentialVault;
  statePath?: string;
}

const MAX_ACTIVITY = 500;
const validId = /^[a-z0-9][a-z0-9-]{0,62}$/;
const validCapabilityId = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const permissionValues = new Set<ConnectorPermission>(['read', 'create', 'update', 'delete', 'execute']);
const retryDelay = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

export function connectorToolName(connectorId: string, capabilityId: string): string {
  return `connector_${connectorId.replaceAll('-', '_')}_${capabilityId.replaceAll('-', '_')}`;
}

function credentialProvider(id: string): `connector:${string}` {
  return `connector:${id}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateManifest(manifest: ConnectorManifest): void {
  if (!validId.test(manifest.id)) throw new Error(`Invalid connector ID: ${manifest.id}`);
  if (!manifest.name.trim() || !manifest.description.trim()) throw new Error(`Connector ${manifest.id} needs a name and description.`);
  const capabilityIds = new Set<string>();
  const toolNames = new Set<string>();
  for (const capability of manifest.capabilities) {
    if (!validCapabilityId.test(capability.id)) throw new Error(`Invalid capability ID: ${manifest.id}/${capability.id}`);
    if (capabilityIds.has(capability.id)) throw new Error(`Duplicate capability ID: ${manifest.id}/${capability.id}`);
    if (!permissionValues.has(capability.permission)) throw new Error(`Invalid permission for ${manifest.id}/${capability.id}.`);
    if (!capability.parameters || capability.parameters.type !== 'object' || !isObject(capability.parameters.properties)) {
      throw new Error(`Capability ${manifest.id}/${capability.id} requires an object input schema.`);
    }
    const name = connectorToolName(manifest.id, capability.id);
    if (toolNames.has(name)) throw new Error(`Connector tool name collision: ${name}`);
    capabilityIds.add(capability.id);
    toolNames.add(name);
  }
  const fieldIds = new Set<string>();
  for (const field of manifest.auth.fields) {
    if (!validId.test(field.id) || fieldIds.has(field.id)) throw new Error(`Invalid or duplicate credential field: ${manifest.id}/${field.id}`);
    fieldIds.add(field.id);
  }
}

function createEmptyState(): ConnectorState {
  return { version: 1, connectedConnectorIds: [], grants: {}, activity: [] };
}

function parseState(value: unknown, statePath: string): ConnectorState {
  if (!isObject(value) || value.version !== 1 || !Array.isArray(value.connectedConnectorIds)
    || !isObject(value.grants) || !Array.isArray(value.activity)) {
    throw new Error(`Connector state at ${statePath} has an unsupported or invalid format.`);
  }
  const connectedConnectorIds = value.connectedConnectorIds;
  if (connectedConnectorIds.some(id => typeof id !== 'string' || !validId.test(id))) {
    throw new Error(`Connector state at ${statePath} contains an invalid connector ID.`);
  }
  const grants: ConnectorState['grants'] = {};
  for (const [agentId, connectors] of Object.entries(value.grants)) {
    if (!agentId || agentId.length > 200 || !isObject(connectors)) {
      throw new Error(`Connector state at ${statePath} contains an invalid agent grant.`);
    }
    const entries: Record<string, string[]> = {};
    for (const [connectorId, capabilities] of Object.entries(connectors)) {
      if (!validId.test(connectorId) || !Array.isArray(capabilities)
        || capabilities.some(capability => typeof capability !== 'string' || !validCapabilityId.test(capability))) {
        throw new Error(`Connector state at ${statePath} contains an invalid capability grant.`);
      }
      entries[connectorId] = [...new Set(capabilities)];
    }
    grants[agentId] = entries;
  }
  const activity = value.activity as ConnectorActivity[];
  if (activity.length > MAX_ACTIVITY || activity.some(item =>
    !isObject(item) || typeof item.id !== 'string' || typeof item.timestamp !== 'number'
    || typeof item.connectorId !== 'string' || !validId.test(item.connectorId)
    || typeof item.capabilityId !== 'string' || !validCapabilityId.test(item.capabilityId)
    || typeof item.agentId !== 'string' || typeof item.success !== 'boolean'
    || typeof item.durationMs !== 'number')) {
    throw new Error(`Connector state at ${statePath} contains invalid activity records.`);
  }
  return {
    version: 1,
    connectedConnectorIds: [...new Set(connectedConnectorIds as string[])],
    grants,
    activity: activity.slice(-MAX_ACTIVITY),
  };
}

function writeAtomically(destination: string, content: string): void {
  const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(temporary, destination);
        break;
      } catch (failure) {
        const error = failure as NodeJS.ErrnoException;
        if (attempt >= 4 || (error.code !== 'EPERM' && error.code !== 'EBUSY')) throw error;
        Atomics.wait(retryDelay, 0, 0, 25 * (attempt + 1));
      }
    }
  } catch (failure) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[connectors] Could not remove temporary state ${temporary}:`, cleanupError);
      }
    }
    throw new Error(`Could not persist connector state at ${destination}: ${failure instanceof Error ? failure.message : String(failure)}`, { cause: failure });
  }
}

function redactError(message: string, credentials: IntegrationCredentials): string {
  let redacted = message;
  for (const [key, value] of Object.entries(credentials)) {
    if (/(?:secret|password|private.?key|api.?key|token)/i.test(key) && value) {
      redacted = redacted.replaceAll(value, '[redacted]');
    }
  }
  return redacted.slice(0, 1_000);
}

export class ConnectorEngine {
  private readonly vault: CredentialVault;
  private readonly statePath: string;
  private readonly adapters = new Map<string, ConnectorAdapter>();
  private readonly liveConnections = new Set<string>();
  private readonly healthById = new Map<string, ConnectorHealth>();
  private state: ConnectorState;

  constructor(options: ConnectorEngineOptions) {
    this.vault = options.vault;
    this.statePath = options.statePath ?? appPath('connectors', 'state.json');
    this.state = this.readState();
  }

  register(adapter: ConnectorAdapter): void {
    validateManifest(adapter.manifest);
    if (this.adapters.has(adapter.manifest.id)) throw new Error(`Connector is already registered: ${adapter.manifest.id}`);
    this.adapters.set(adapter.manifest.id, adapter);
  }

  registerMany(adapters: ConnectorAdapter[]): void {
    for (const adapter of adapters) this.register(adapter);
  }

  list(): ConnectorCatalogEntry[] {
    return [...this.adapters.values()].map(adapter => {
      const id = adapter.manifest.id;
      const health = this.healthById.get(id) ?? { state: 'disconnected', checkedAt: 0 };
      return {
        manifest: adapter.manifest,
        configured: this.state.connectedConnectorIds.includes(id) || this.vault.has(credentialProvider(id)),
        connected: this.liveConnections.has(id),
        health,
      };
    });
  }

  async connect(connectorId: string, input: unknown): Promise<ConnectorCatalogEntry> {
    const adapter = this.requireAdapter(connectorId);
    const credentials = this.validateCredentials(adapter.manifest, input);
    await adapter.connect?.(credentials);
    const health = await adapter.health(credentials);
    this.healthById.set(connectorId, health);
    if (health.state !== 'connected') {
      await adapter.disconnect?.();
      throw new Error(health.message ?? `${adapter.manifest.name} did not confirm a healthy connection.`);
    }
    if (Object.keys(credentials).length) this.vault.set(credentialProvider(connectorId), credentials);
    this.liveConnections.add(connectorId);
    this.state.connectedConnectorIds = [...new Set([...this.state.connectedConnectorIds, connectorId])];
    this.persist();
    this.recordActivity({
      connectorId,
      capabilityId: 'connection',
      agentId: 'user',
      success: true,
      durationMs: 0,
    });
    return this.list().find(entry => entry.manifest.id === connectorId)!;
  }

  async disconnect(connectorId: string): Promise<void> {
    const adapter = this.requireAdapter(connectorId);
    await adapter.disconnect?.();
    this.vault.delete(credentialProvider(connectorId));
    this.liveConnections.delete(connectorId);
    this.healthById.set(connectorId, { state: 'disconnected', checkedAt: Date.now() });
    this.state.connectedConnectorIds = this.state.connectedConnectorIds.filter(id => id !== connectorId);
    this.persist();
    this.recordActivity({
      connectorId,
      capabilityId: 'disconnection',
      agentId: 'user',
      success: true,
      durationMs: 0,
    });
  }

  async restoreConnections(): Promise<void> {
    const connectorIds = [...new Set([
      ...this.state.connectedConnectorIds,
      ...[...this.adapters.keys()].filter(id => this.vault.has(credentialProvider(id))),
    ])];
    await Promise.all(connectorIds.map(async connectorId => {
      if (this.liveConnections.has(connectorId)) return;
      const adapter = this.adapters.get(connectorId);
      if (!adapter) {
        console.warn(`[connectors] Saved connector ${connectorId} is not registered.`);
        return;
      }
      const credentials = this.vault.get(credentialProvider(connectorId)) ?? {};
      try {
        await adapter.connect?.(credentials);
        const health = await adapter.health(credentials);
        this.healthById.set(connectorId, health);
        if (health.state === 'connected') this.liveConnections.add(connectorId);
        else console.warn(`[connectors] ${adapter.manifest.name} is configured but unavailable: ${health.message ?? health.state}`);
      } catch (failure) {
        const message = redactError(failure instanceof Error ? failure.message : String(failure), credentials);
        this.healthById.set(connectorId, { state: 'error', checkedAt: Date.now(), message });
        console.error(`[connectors] Could not restore ${adapter.manifest.name}: ${message}`);
      }
    }));
  }

  setAgentCapabilities(agentId: string, connectorId: string, capabilityIds: string[]): void {
    if (!agentId.trim() || agentId.length > 200) throw new Error('A valid agent ID is required.');
    const adapter = this.requireAdapter(connectorId);
    if (!Array.isArray(capabilityIds)) throw new Error('Capabilities must be a list.');
    const validCapabilities = new Set(adapter.manifest.capabilities.map(capability => capability.id));
    const unique = [...new Set(capabilityIds)];
    if (unique.some(capabilityId => !validCapabilities.has(capabilityId))) {
      throw new Error('One or more requested capabilities are not available for this connector.');
    }
    const agentGrants = this.state.grants[agentId] ?? {};
    if (unique.length) agentGrants[connectorId] = unique;
    else delete agentGrants[connectorId];
    if (Object.keys(agentGrants).length) this.state.grants[agentId] = agentGrants;
    else delete this.state.grants[agentId];
    this.persist();
  }

  getAgentCapabilities(agentId: string): Record<string, string[]> {
    const grants = this.state.grants[agentId] ?? {};
    return Object.fromEntries(Object.entries(grants).map(([connectorId, capabilityIds]) => [
      connectorId,
      [...capabilityIds],
    ]));
  }

  allowedToolNames(agentId: string): string[] {
    const grants = this.state.grants[agentId] ?? {};
    return Object.entries(grants).flatMap(([connectorId, capabilityIds]) =>
      this.liveConnections.has(connectorId)
        ? capabilityIds.map(capabilityId => connectorToolName(connectorId, capabilityId))
        : [],
    );
  }

  activity(limit = 100): ConnectorActivity[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ACTIVITY) {
      throw new RangeError(`Activity limit must be between 1 and ${MAX_ACTIVITY}.`);
    }
    return this.state.activity.slice(-limit).reverse();
  }

  tools(): ToolDefinition[] {
    return [...this.adapters.values()].flatMap(adapter => adapter.manifest.capabilities.map(capability => ({
      name: connectorToolName(adapter.manifest.id, capability.id),
      description: `[${adapter.manifest.name}] ${capability.description}`,
      parameters: capability.parameters,
      connectorId: adapter.manifest.id,
      idempotency: {
        class: capability.permission === 'read' ? 'read' as const : 'external' as const,
        externalSystem: adapter.manifest.name,
        idempotencyKey: (input: Record<string, unknown>) =>
          `${adapter.manifest.id}:${capability.id}:${crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex')}`,
      },
      execute: async (input: Record<string, unknown>, options) => {
        const agentId = options?.agentId;
        if (!agentId || !this.hasCapability(agentId, adapter.manifest.id, capability.id)) {
          throw new Error(`Agent is not authorized to use ${adapter.manifest.name}/${capability.name}. Grant this capability in Connectors > Permissions.`);
        }
        if (!this.liveConnections.has(adapter.manifest.id)) {
          throw new Error(`${adapter.manifest.name} is not connected. Reconnect it in the Connectors workspace.`);
        }
        const credentials = this.vault.get(credentialProvider(adapter.manifest.id)) ?? {};
        const startedAt = Date.now();
        const context: ConnectorExecutionContext = {
          agentId,
          ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
          ...(options?.signal ? { signal: options.signal } : {}),
          ...(options?.googleWorkspaceAccessToken ? { googleWorkspaceAccessToken: options.googleWorkspaceAccessToken } : {}),
        };
        try {
          const result = await adapter.execute(capability.id, input, credentials, context);
          this.recordActivity({
            connectorId: adapter.manifest.id,
            capabilityId: capability.id,
            agentId,
            ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
            success: true,
            durationMs: Date.now() - startedAt,
          });
          if (typeof result === 'string') return result.slice(0, 100_000);
          const serialized = JSON.stringify(result);
          return serialized.length > 100_000 ? `${serialized.slice(0, 100_000)}\n[connector result truncated]` : serialized;
        } catch (failure) {
          const message = redactError(failure instanceof Error ? failure.message : String(failure), credentials);
          this.recordActivity({
            connectorId: adapter.manifest.id,
            capabilityId: capability.id,
            agentId,
            ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
            success: false,
            durationMs: Date.now() - startedAt,
            error: message,
          });
          throw new Error(message, { cause: failure });
        }
      },
    })));
  }

  private hasCapability(agentId: string, connectorId: string, capabilityId: string): boolean {
    return this.state.grants[agentId]?.[connectorId]?.includes(capabilityId) === true;
  }

  private validateCredentials(manifest: ConnectorManifest, input: unknown): IntegrationCredentials {
    if (!isObject(input)) throw new Error('Connector credentials must be a JSON object.');
    const credentials: IntegrationCredentials = {};
    for (const field of manifest.auth.fields) {
      const value = input[field.id];
      if (value === undefined || value === '') {
        if (field.required) throw new Error(`${field.label} is required.`);
        continue;
      }
      if (typeof value !== 'string' || value.length > 64_000) {
        throw new Error(`${field.label} must be a string of at most 64 KB.`);
      }
      credentials[field.id] = value.trim();
    }
    const unsupported = Object.keys(input).filter(key => !manifest.auth.fields.some(field => field.id === key));
    if (unsupported.length) throw new Error(`Unsupported credential field: ${unsupported[0]}`);
    return credentials;
  }

  private recordActivity(activity: Omit<ConnectorActivity, 'id' | 'timestamp'>): void {
    this.state.activity.push({
      ...activity,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
    });
    if (this.state.activity.length > MAX_ACTIVITY) this.state.activity.splice(0, this.state.activity.length - MAX_ACTIVITY);
    this.persist();
  }

  private requireAdapter(connectorId: string): ConnectorAdapter {
    const adapter = this.adapters.get(connectorId);
    if (!adapter) throw new Error(`Unknown connector: ${connectorId}`);
    return adapter;
  }

  private readState(): ConnectorState {
    try {
      return parseState(JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as unknown, this.statePath);
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code === 'ENOENT') return createEmptyState();
      throw new Error(`Could not load connector state: ${failure instanceof Error ? failure.message : String(failure)}`, { cause: failure });
    }
  }

  private persist(): void {
    writeAtomically(this.statePath, `${JSON.stringify(this.state, null, 2)}\n`);
  }
}
