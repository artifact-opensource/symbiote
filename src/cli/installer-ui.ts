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
  path.resolve(__dirname, '..', '..', 'web', 'installer.html'),
  path.resolve(process.cwd(), 'web', 'installer.html'),
];

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function toSetupInput(payload: Record<string, unknown>): SetupInput {
  const existing = fs.existsSync(path.resolve('mach6.json')) ? loadConfig(path.resolve('mach6.json')) : undefined;
  const defaults = defaultSetupInput(existing);
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

export async function startInstallerUi(port = 3010): Promise<http.Server> {
  const existing = fs.existsSync(path.resolve('mach6.json')) ? loadConfig(path.resolve('mach6.json')) : undefined;
  const defaults = defaultSetupInput(existing);
  const htmlPath = installerHtmlCandidates.find(candidate => fs.existsSync(candidate));
  if (!htmlPath) {
    throw new Error('installer.html not found');
  }

  const server = http.createServer(async (req, res) => {
    try {
      const method = req.method ?? 'GET';
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;

      if (method === 'GET' && pathname === '/api/defaults') {
        return json(res, {
          version: APP_VERSION,
          codename: RELEASE_CODENAME,
          providers: PROVIDERS,
          defaults,
        });
      }

      if (method === 'POST' && pathname === '/api/setup') {
        const payload = JSON.parse(await readBody(req) || '{}') as Record<string, unknown>;
        const result = writeSetupFiles(toSetupInput(payload));
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
      json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });

  const url = `http://127.0.0.1:${port}`;
  console.log(`Installer UI → ${url}`);
  openBrowser(url);
  return server;
}
