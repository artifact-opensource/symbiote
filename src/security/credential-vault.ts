import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import { appPath } from '../runtime/platform.js';

export type IntegrationProvider = 'azure' | 'oci' | 'n8n' | 'kaggle';
export type CredentialProvider = IntegrationProvider | 'discord';
export type IntegrationCredentials = Record<string, string>;

interface EncryptedVault {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

const KEY_NAME = 'SYMBIOTE_VAULT_KEY';

export interface CredentialVaultOptions {
  adminEnvPath?: string;
  vaultPath?: string;
}

export class CredentialVault {
  private readonly adminEnvPath: string;
  private readonly vaultPath: string;

  constructor(options: CredentialVaultOptions = {}) {
    this.adminEnvPath = options.adminEnvPath ?? process.env.SYMBIOTE_ADMIN_ENV
      ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.admin', '.env');
    this.vaultPath = options.vaultPath ?? appPath('vault', 'integrations.enc');
  }

  getPath(): string {
    return this.vaultPath;
  }

  has(provider: CredentialProvider): boolean {
    return Object.keys(this.read()[provider] ?? {}).length > 0;
  }

  get(provider: CredentialProvider): IntegrationCredentials | null {
    const credentials = this.read()[provider];
    return credentials && Object.keys(credentials).length ? { ...credentials } : null;
  }

  set(provider: CredentialProvider, credentials: IntegrationCredentials): void {
    const vault = this.read();
    const previous = vault[provider] ?? {};
    const merged = { ...previous };
    for (const [key, value] of Object.entries(credentials)) {
      if (typeof value !== 'string') throw new TypeError(`Credential "${key}" must be a string.`);
      if (value.length > 64_000) throw new RangeError(`Credential "${key}" exceeds the 64 KB limit.`);
      if (value.length > 0) merged[key] = value;
    }
    vault[provider] = merged;
    this.write(vault);
  }

  migrateDiscordCredentials(envPath: string): IntegrationCredentials | null {
    if (!fs.existsSync(envPath)) return null;
    const environmentText = fs.readFileSync(envPath, 'utf8');
    const environment = parse(environmentText);
    const credentials: IntegrationCredentials = {};
    if (environment.DISCORD_BOT_TOKEN?.trim()) credentials.token = environment.DISCORD_BOT_TOKEN.trim();
    if (environment.DISCORD_CLIENT_ID?.trim()) credentials.clientId = environment.DISCORD_CLIENT_ID.trim();
    if (!Object.keys(credentials).length) return null;

    this.set('discord', credentials);
    const stored = this.get('discord');
    if (!stored || Object.entries(credentials).some(([key, value]) => stored[key] !== value)) {
      throw new Error('Discord credentials could not be verified in the encrypted vault; the environment file was not changed.');
    }

    return stored;
  }

  delete(provider: CredentialProvider): void {
    const vault = this.read();
    delete vault[provider];
    this.write(vault);
  }

  private read(): Partial<Record<CredentialProvider, IntegrationCredentials>> {
    const key = this.loadKey();
    if (!fs.existsSync(this.vaultPath)) return {};
    const raw = fs.readFileSync(this.vaultPath, 'utf8');
    let envelope: EncryptedVault;
    try {
      envelope = JSON.parse(raw) as EncryptedVault;
    } catch {
      throw new Error('The encrypted integration vault is not valid JSON. It was not modified.');
    }
    if (envelope.version !== 1 || !envelope.iv || !envelope.tag || !envelope.ciphertext) {
      throw new Error('The encrypted integration vault has an unsupported or incomplete format.');
    }
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
      const value: unknown = JSON.parse(plaintext);
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Vault payload must be an object.');
      }
      return value as Partial<Record<CredentialProvider, IntegrationCredentials>>;
    } catch (failure) {
      throw new Error(`Could not decrypt the integration vault. Check ${KEY_NAME} in the external admin environment file; encrypted data was not changed.`, { cause: failure });
    }
  }

  private write(value: Partial<Record<CredentialProvider, IntegrationCredentials>>): void {
    const key = this.loadKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value), 'utf8'),
      cipher.final(),
    ]);
    const envelope: EncryptedVault = {
      version: 1,
      iv: iv.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
    };
    const directory = path.dirname(this.vaultPath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.vaultPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, `${JSON.stringify(envelope)}\n`, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporaryPath, this.vaultPath);
    } finally {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    }
  }

  private loadKey(): Buffer {
    let keyValue = process.env[KEY_NAME]?.trim();
    let environmentText = '';
    if (!keyValue) {
      try {
        environmentText = fs.readFileSync(this.adminEnvPath, 'utf8');
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new Error(`Could not read external vault key file ${this.adminEnvPath}.`, { cause: failure });
        }
      }
      keyValue = parse(environmentText)[KEY_NAME]?.trim();
    }

    if (!keyValue) {
      keyValue = crypto.randomBytes(32).toString('base64url');
      const directory = path.dirname(this.adminEnvPath);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const separator = environmentText && !environmentText.endsWith('\n') ? '\n' : '';
      fs.appendFileSync(this.adminEnvPath, `${separator}${KEY_NAME}=${keyValue}\n`, { flag: 'a', mode: 0o600 });
    }

    const key = Buffer.from(keyValue, 'base64url');
    if (key.length !== 32) {
      throw new Error(`${KEY_NAME} in ${this.adminEnvPath} must be a 32-byte base64url key.`);
    }
    return key;
  }
}
