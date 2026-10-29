import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { APP_VERSION, RELEASE_CODENAME } from '../meta/version.js';
import { defaultSetupInput, PROVIDERS, writeSetupFiles, type SetupInput } from './setup.js';
import { loadConfig } from '../config/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const installerHtmlCandidates = [
  path.resolve(__dirname, '..', 'web', 'installer.html'),
  path.resolve(__dirname, '..', '..', 'web', 'installer.html'),
  path.resolve(process.cwd(), 'web', 'installer.html'),
];

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let rejected = false;
    const contentLength = Number(req.headers['content-length']);
    if (Number.isFinite(contentLength) && contentLength > 64 * 1024) {
      reject(Object.assign(new Error('Installer request exceeds the 64 KiB limit.'), { statusCode: 413 }));
      req.resume();
      return;
    }
    req.on('data', chunk => {
      const buffer = chunk as Buffer;
      bytes += buffer.length;
      if (bytes > 64 * 1024) {
        rejected = true;
        chunks.length = 0;
        reject(Object.assign(new Error('Installer request exceeds the 64 KiB limit.'), { statusCode: 413 }));
        req.resume();
        return;
      }
      if (!rejected) chunks.push(buffer);
    });
    req.on('end', () => {
      if (!rejected) resolve(Buffer.concat(chunks).toString('utf-8'));
    });
    req.on('error', reject);
  });
}

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function toSetupInput(payload: Record<string, unknown>, configDirectory: string): SetupInput {
  const configPath = path.join(configDirectory, 'symbiote.json');
  const envPath = path.join(configDirectory, '.env');
  const existing = fs.existsSync(configPath) ? loadConfig(configPath) : undefined;
  const defaults = defaultSetupInput(existing, envPath);
  if (!existing) {
    defaults.workspace = path.join(configDirectory, 'workspace');
    defaults.whatsappAuthDir = path.join(configDirectory, '.whatsapp-auth');
  }
  const bool = (value: unknown, fallback = false) => value === true || value === 'true' || (value === undefined ? fallback : false);
  const num = (value: unknown, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const csv = (value: unknown) => String(value ?? '').split(',').map(s => s.trim()).filter(Boolean);

  return {
    provider: String(payload.provider ?? defaults.provider),
    model: String(payload.model ?? defaults.model),
    providerApiKey: String(payload.providerApiKey ?? defaults.providerApiKey ?? ''),
    workspace: path.resolve(String(payload.workspace ?? defaults.workspace)),
    sessionsDir: String(payload.sessionsDir ?? defaults.sessionsDir),
    temperature: num(payload.temperature, defaults.temperature),
    maxTokens: num(payload.maxTokens, defaults.maxTokens),
    maxIterations: num(payload.maxIterations, defaults.maxIterations),
    ownerIds: csv(payload.ownerIds),
    apiPort: num(payload.apiPort, defaults.apiPort),
    apiHost: String(payload.apiHost ?? defaults.apiHost),
    webPort: num(payload.webPort, defaults.webPort),
    webHost: String(payload.webHost ?? defaults.webHost),
    discordEnabled: bool(payload.discordEnabled, defaults.discordEnabled),
    discordToken: String(payload.discordToken ?? defaults.discordToken ?? ''),
    discordBotId: String(payload.discordBotId ?? defaults.discordBotId ?? ''),
    whatsappEnabled: bool(payload.whatsappEnabled, defaults.whatsappEnabled),
    whatsappPhoneNumber: String(payload.whatsappPhoneNumber ?? defaults.whatsappPhoneNumber ?? ''),
    whatsappAuthDir: path.resolve(String(payload.whatsappAuthDir ?? defaults.whatsappAuthDir)),
    agent: {
      enabled: bool(payload.agentEnabled, defaults.agent.enabled),
      name: String(payload.agentName ?? defaults.agent.name),
      emoji: String(payload.agentEmoji ?? defaults.agent.emoji),
      personality: String(payload.agentPersonality ?? defaults.agent.personality),
      creatorName: String(payload.creatorName ?? defaults.agent.creatorName),
    },
  };
}

function openBrowser(url: string): void {
  const command = process.platform === 'win32'
    ? `start "" "${url}"`
    : process.platform === 'darwin'
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(command, () => {});
}

function clientErrorMessage(err: unknown): string {
  if (err instanceof SyntaxError) {
    return 'Invalid installer request payload';
  }
  if (err instanceof Error && err.message === 'Generated configuration failed validation') {
    return err.message;
  }
  if (typeof err === 'object' && err !== null && 'statusCode' in err && err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = String((err as { code?: unknown }).code);
    if (code === 'EACCES' || code === 'EPERM') {
      return 'Permission denied while writing installer files';
    }
    if (code === 'ENOENT') {
      return 'A required installer file or directory was not found';
    }
  }
  return 'Installer request failed. Check the terminal for details.';
}

function clientErrorStatus(err: unknown): number {
  if (typeof err === 'object' && err !== null && 'statusCode' in err) {
    const statusCode = Number((err as { statusCode?: unknown }).statusCode);
    if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500) return statusCode;
  }
  if (err instanceof SyntaxError || (err instanceof Error && err.message === 'Generated configuration failed validation')) return 400;
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = String((err as { code?: unknown }).code);
    if (code === 'EACCES' || code === 'EPERM') return 403;
    if (code === 'ENOENT') return 400;
  }
  return 500;
}

function isTrustedInstallerRequest(req: http.IncomingMessage): boolean {
  const remoteAddress = req.socket.remoteAddress ?? '';
  if (remoteAddress !== '127.0.0.1' && remoteAddress !== '::1' && !remoteAddress.startsWith('::ffff:127.')) return false;
  const host = req.headers.host;
  if (!host) return false;
  let hostname = '';
  try {
    hostname = new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') return false;
  const origin = req.headers.origin;
  return !origin || origin === `http://${host}`;
}

export async function startInstallerUi(
  port = 3010,
  configDirectory = process.cwd(),
  launchBrowser = true,
): Promise<http.Server> {
  const resolvedConfigDirectory = path.resolve(configDirectory);
  const configPath = path.join(resolvedConfigDirectory, 'symbiote.json');
  const envPath = path.join(resolvedConfigDirectory, '.env');
  const existing = fs.existsSync(configPath) ? loadConfig(configPath) : undefined;
  const defaults = defaultSetupInput(existing, envPath);
  if (!existing) {
    defaults.workspace = path.join(resolvedConfigDirectory, 'workspace');
    defaults.whatsappAuthDir = path.join(resolvedConfigDirectory, '.whatsapp-auth');
  }
  const htmlPath = installerHtmlCandidates.find(candidate => fs.existsSync(candidate));
  if (!htmlPath) {
    throw new Error('installer.html not found');
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!isTrustedInstallerRequest(req)) {
        return json(res, { error: 'Installer requests must use its loopback origin.' }, 403);
      }
      const method = req.method ?? 'GET';
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;

      if (method === 'GET' && pathname === '/api/defaults') {
        const { providerApiKey, discordToken, ...safeDefaults } = defaults;
        return json(res, {
          version: APP_VERSION,
          codename: RELEASE_CODENAME,
          providers: PROVIDERS,
          defaults: {
            ...safeDefaults,
            hasProviderApiKey: Boolean(providerApiKey),
            hasDiscordToken: Boolean(discordToken),
          },
        });
      }

      if (method === 'POST' && pathname === '/api/setup') {
        if (req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
          return json(res, { error: 'Installer requests must use application/json.' }, 415);
        }
        const payload = JSON.parse(await readBody(req) || '{}') as Record<string, unknown>;
        const result = writeSetupFiles(toSetupInput(payload, resolvedConfigDirectory), configPath, envPath);
        return json(res, {
          ok: true,
          configPath: result.configPath,
          envPath: result.envPath,
          createdIdentityFiles: result.createdIdentityFiles,
          whatsappEnabled: result.config.whatsapp?.enabled ?? false,
        });
      }

      if (method === 'GET' && pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(htmlPath, 'utf-8'));
        return;
      }

      json(res, { error: 'Not found' }, 404);
    } catch (err) {
      console.error('[installer-ui] request failed:', err);
      json(res, { error: clientErrorMessage(err) }, clientErrorStatus(err));
    }
  });

  const listen = (listenPort: number) => new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, '127.0.0.1', () => resolve());
  });
  try {
    await listen(port);
  } catch (error) {
    if (port === 0 || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    console.warn(`[installer-ui] Port ${port} is already in use; selecting an available loopback port.`);
    await listen(0);
  }

  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Installer UI did not bind to a TCP port.');
  const url = `http://127.0.0.1:${address.port}`;
  console.log(`Installer UI → ${url}`);
  if (launchBrowser) openBrowser(url);
  return server;
}
