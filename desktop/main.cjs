const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, Tray } = require('electron');
const { execFile, execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const { promisify } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');

const execFileAsync = promisify(execFile);
const isDesktopDev = process.env.SYMBIOTE_DESKTOP_URL;
let mainWindow;
let miniWindow;
let tray;
let overlayOpacity = 0.88;
let declinedFirewallPort;
let desktopTheme;
const preferencesPath = path.join(app.getPath('userData'), 'desktop-preferences.json');
const gatewayProcessPath = path.join(app.getPath('userData'), 'gateway-process.json');
let gatewayStartup;
let gatewayChild;
let gatewayRestartTimer;
let gatewayRestartAttempts = 0;
let gatewayMonitorTimer;
let gatewayMonitorRunning = false;
let gatewayRestarting = false;
let electronQuitting = false;
let gatewayStopping = false;
let serviceManagedGateway = false;
let desktopControlServer;
let desktopControlPath;
let desktopControlToken;
let updateInstallArmed = false;
let updateInstallTimer;
let resolveUpdateInstall;

function finishUpdateInstall(started) {
  if (updateInstallTimer) clearTimeout(updateInstallTimer);
  updateInstallTimer = undefined;
  updateInstallArmed = false;
  const resolve = resolveUpdateInstall;
  resolveUpdateInstall = undefined;
  resolve?.(started);
}
const ownsSingleInstanceLock = app.requestSingleInstanceLock();

try {
  const preferences = JSON.parse(fs.readFileSync(preferencesPath, 'utf8'));
  if (Number.isFinite(preferences.overlayOpacity) && preferences.overlayOpacity >= 0.35 && preferences.overlayOpacity <= 1) {
    overlayOpacity = preferences.overlayOpacity;
  }
  if (Number.isInteger(preferences.declinedFirewallPort)) declinedFirewallPort = preferences.declinedFirewallPort;
  if (preferences.desktopTheme === 'dark' || preferences.desktopTheme === 'light') desktopTheme = preferences.desktopTheme;
} catch (error) {
  if (error.code !== 'ENOENT') console.error('Could not read desktop preferences:', error);
}

function readGatewaySettings() {
  const gateway = readGatewayConfig();
  return { host: gateway.bindHost, port: gateway.port };
}

function isLoopbackHost(host) {
  const normalized = String(host).trim().toLowerCase();
  return normalized === 'localhost' || normalized === '::1' || normalized === '127.0.0.1' || normalized.startsWith('127.');
}

function firewallScriptPath() {
  return path.join(__dirname, '..', 'scripts', 'windows', 'configure-firewall.ps1');
}

function installedDataDirectory() {
  if (process.platform !== 'win32') return undefined;
  try {
    const registry = execFileSync('reg.exe', ['query', 'HKLM\\Software\\Artifact Virtual\\Symbiote', '/v', 'DataDirectory'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return registry.match(/DataDirectory\s+REG_SZ\s+(.+)/i)?.[1]?.trim();
  } catch (error) {
    if (error.status !== 1 && error.code !== 'ENOENT') console.error('Could not read the Symbiote data directory from the registry:', error);
    return undefined;
  }
}

function readGatewayConfig() {
  const dataDirectory = installedDataDirectory();
  const candidates = [
    process.env.SYMBIOTE_CONFIG,
    ...(app.isPackaged && dataDirectory ? [path.join(dataDirectory, 'symbiote.json')] : []),
    path.join(process.cwd(), 'symbiote.json'),
    ...(!app.isPackaged && dataDirectory ? [path.join(dataDirectory, 'symbiote.json')] : []),
  ].filter(Boolean);
  for (const candidate of [...new Set(candidates)]) {
    const configPath = path.resolve(candidate);
    if (!fs.existsSync(configPath)) continue;
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const port = config.webPort === undefined ? 3009 : Number(config.webPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new RangeError(`Invalid configured web port in ${configPath}: ${config.webPort}`);
    }
    const environmentPath = path.join(path.dirname(configPath), '.env');
    let environmentHost = '';
    try {
      environmentHost = fs.readFileSync(environmentPath, 'utf8')
        .match(/^\s*SYMBIOTE_WEB_HOST\s*=\s*["']?([^"'#\r\n]+)["']?\s*$/m)?.[1]?.trim() ?? '';
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const configuredHost = process.env.SYMBIOTE_WEB_HOST || environmentHost || config.webHost || '127.0.0.1';
    const host = configuredHost === '0.0.0.0' || configuredHost === '::' ? '127.0.0.1' : configuredHost;
    const formattedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    return {
      configPath,
      configDirectory: path.dirname(configPath),
      workspace: path.resolve(config.workspace || path.dirname(configPath)),
      daemonPath: path.join(__dirname, '..', 'dist', 'gateway', 'daemon.js'),
      bindHost: configuredHost,
      port,
      url: `http://${formattedHost}:${port}`,
    };
  }
  throw new Error(`Could not find symbiote.json. Checked: ${candidates.map(file => path.resolve(file)).join(', ')}`);
}

function startDesktopControl(gateway) {
  desktopControlPath = path.join(gateway.configDirectory, '.session', 'desktop-control.json');
  desktopControlToken = crypto.randomBytes(32).toString('base64url');
  const server = http.createServer((request, response) => {
    const action = request.url;
    const suppliedToken = request.headers['x-symbiote-control-token'];
    const suppliedBytes = typeof suppliedToken === 'string' ? Buffer.from(suppliedToken) : undefined;
    const expectedBytes = Buffer.from(desktopControlToken);
    if (request.method !== 'POST' || !['/quit', '/focus', '/status'].includes(action)
      || !suppliedBytes || suppliedBytes.length !== expectedBytes.length
      || !crypto.timingSafeEqual(suppliedBytes, expectedBytes)) {
      response.writeHead(404).end();
      return;
    }
    if (action === '/status') {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        pid: process.pid,
        gatewayPid: gatewayChild?.pid ?? null,
        gatewayMode: serviceManagedGateway ? 'service' : 'electron',
      }));
      return;
    }
    response.writeHead(202, { 'Content-Type': 'application/json' }).end(JSON.stringify({ accepted: true }));
    setImmediate(() => {
      if (action === '/quit') app.quit();
      else {
        const window = mainWindow || miniWindow;
        if (!window) return;
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
      }
    });
  });
  desktopControlServer = server;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      try {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Could not determine the desktop control port.');
        fs.mkdirSync(path.dirname(desktopControlPath), { recursive: true });
        fs.writeFileSync(desktopControlPath, JSON.stringify({
          pid: process.pid,
          port: address.port,
          token: desktopControlToken,
        }), { encoding: 'utf8', mode: 0o600 });
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

function gatewayHealthCheck(gateway) {
  return new Promise(resolve => {
    const request = http.get(`${gateway.url}/api/status`, { timeout: 2000 }, response => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.once('timeout', () => {
      request.destroy();
      resolve(false);
    });
    request.once('error', () => resolve(false));
  });
}

function readGatewayJson(gateway, pathname) {
  return new Promise(resolve => {
    const request = http.get(`${gateway.url}${pathname}`, { timeout: 2000 }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 200) return resolve(undefined);
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(undefined);
        }
      });
    });
    request.once('timeout', () => {
      request.destroy();
      resolve(undefined);
    });
    request.once('error', () => resolve(undefined));
  });
}

function gatewayPortInUse(gateway) {
  const url = new URL(gateway.url);
  return new Promise(resolve => {
    const socket = net.connect({ host: url.hostname.replace(/^\[|\]$/g, ''), port: gateway.port });
    socket.setTimeout(1500);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}

function serviceState() {
  if (process.platform !== 'win32') return undefined;
  try {
    const output = execFileSync('sc.exe', ['query', 'SymbioteGateway'], { encoding: 'utf8', windowsHide: true });
    return output.match(/STATE\s*:\s*\d+\s+([A-Z_]+)/i)?.[1]?.toUpperCase() ?? 'UNKNOWN';
  } catch (error) {
    const details = `${error.stdout ?? ''}${error.stderr ?? ''}${error.message ?? ''}`;
    if (/1060|does not exist as an installed service/i.test(details)) return undefined;
    throw new Error(`Could not inspect the SymbioteGateway service: ${details.trim()}`);
  }
}

async function waitForGateway(gateway, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await gatewayHealthCheck(gateway)) return true;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return gatewayHealthCheck(gateway);
}

function managedGatewayProcess(pid, gateway) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  if (process.platform === 'win32') {
    const script = '$p=Get-CimInstance Win32_Process -Filter "ProcessId = $env:SYMBIOTE_GATEWAY_PID"; $scriptMatch=$p.CommandLine -and $p.CommandLine.IndexOf($env:SYMBIOTE_GATEWAY_SCRIPT,[StringComparison]::OrdinalIgnoreCase) -ge 0; $configMatch=$p.CommandLine -and $p.CommandLine.IndexOf($env:SYMBIOTE_GATEWAY_CONFIG,[StringComparison]::OrdinalIgnoreCase) -ge 0; if ($p -and $scriptMatch -and $configMatch) { exit 0 }; exit 1';
    try {
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        windowsHide: true,
        env: {
          ...process.env,
          SYMBIOTE_GATEWAY_PID: String(pid),
          SYMBIOTE_GATEWAY_SCRIPT: gateway.daemonPath,
          SYMBIOTE_GATEWAY_CONFIG: gateway.configPath,
        },
      });
      return true;
    } catch {
      return false;
    }
  }
  try {
    const commandLine = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return commandLine.includes(gateway.daemonPath) && commandLine.includes(gateway.configPath);
  } catch {
    return false;
  }
}

async function stopStaleManagedGateway(gateway) {
  let previous;
  try {
    previous = JSON.parse(fs.readFileSync(gatewayProcessPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('Could not read the previous Electron-managed Gateway process record:', error);
      return;
    }
  }
  if (!previous) return;
  if (!Number.isInteger(previous.pid) || typeof previous.daemonPath !== 'string' || typeof previous.configPath !== 'string') {
    fs.rmSync(gatewayProcessPath, { force: true });
    return;
  }
  const previousGateway = {
    daemonPath: path.resolve(previous.daemonPath),
    configPath: path.resolve(previous.configPath),
  };
  if (!managedGatewayProcess(previous.pid, previousGateway)) {
    fs.rmSync(gatewayProcessPath, { force: true });
    return;
  }
  try {
    process.kill(previous.pid, 'SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && managedGatewayProcess(previous.pid, previousGateway)) {
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (managedGatewayProcess(previous.pid, previousGateway)) {
    try {
      if (process.platform === 'win32') {
        await execFileAsync('taskkill.exe', ['/PID', String(previous.pid), '/T', '/F'], { windowsHide: true });
      } else {
        process.kill(previous.pid, 'SIGKILL');
      }
    } catch (error) {
      if (managedGatewayProcess(previous.pid, previousGateway) && error.code !== 'ESRCH' && error.code !== 'ENOENT') throw error;
    }
    const killDeadline = Date.now() + 3000;
    while (Date.now() < killDeadline && managedGatewayProcess(previous.pid, previousGateway)) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  if (managedGatewayProcess(previous.pid, previousGateway)) {
    throw new Error(`The previous Gateway process ${previous.pid} is still running; refusing to start a duplicate.`);
  }
  fs.rmSync(gatewayProcessPath, { force: true });
}

async function stopGatewayProcess(pid, gateway) {
  if (!managedGatewayProcess(pid, gateway)) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && managedGatewayProcess(pid, gateway)) {
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (managedGatewayProcess(pid, gateway)) {
    try {
      if (process.platform === 'win32') {
        await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      } else {
        process.kill(pid, 'SIGKILL');
      }
    } catch (error) {
      if (managedGatewayProcess(pid, gateway) && error.code !== 'ESRCH' && error.code !== 'ENOENT') throw error;
    }
  }
  const killDeadline = Date.now() + 3000;
  while (Date.now() < killDeadline && managedGatewayProcess(pid, gateway)) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (managedGatewayProcess(pid, gateway)) {
    throw new Error(`The previous Gateway process ${pid} could not be stopped safely.`);
  }
}

function resolveNodeExecutable() {
  if (process.env.SYMBIOTE_NODE) return process.env.SYMBIOTE_NODE;
  const bundledNode = path.join(__dirname, '..', 'node.exe');
  if (fs.existsSync(bundledNode)) return bundledNode;
  if (process.platform === 'win32') {
    try {
      const candidates = execFileSync('where.exe', ['node.exe'], { encoding: 'utf8', windowsHide: true })
        .split(/\r?\n/)
        .map(candidate => candidate.trim())
        .filter(candidate => candidate && path.resolve(candidate).toLowerCase() !== path.resolve(process.execPath).toLowerCase());
      if (candidates.length) return candidates[0];
    } catch (error) {
      if (error.status !== 1 && error.code !== 'ENOENT') console.error('Could not locate a standalone Node.js runtime:', error);
    }
  } else {
    for (const directory of (process.env.PATH || '').split(path.delimiter)) {
      const candidate = path.join(directory, 'node');
      if (fs.existsSync(candidate) && path.resolve(candidate) !== path.resolve(process.execPath)) return candidate;
    }
  }
  return process.execPath;
}

function writeGatewayProcessRecord(record) {
  const temporaryPath = `${gatewayProcessPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryPath, gatewayProcessPath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function launchGateway(gateway) {
  if (!fs.existsSync(gateway.daemonPath)) {
    throw new Error(`Built Gateway entry point is missing: ${gateway.daemonPath}. Rebuild the application before launching Electron.`);
  }
  const executable = resolveNodeExecutable();
  const logDirectory = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(logDirectory, { recursive: true });
  const logHandle = fs.openSync(path.join(logDirectory, 'gateway.log'), 'a');
  const child = spawn(executable, [gateway.daemonPath, `--config=${gateway.configPath}`], {
    cwd: gateway.configDirectory,
    detached: false,
    windowsHide: true,
    stdio: ['ignore', logHandle, logHandle],
    env: {
      ...process.env,
      ...(executable === process.execPath && !process.env.SYMBIOTE_NODE ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    },
  });
  fs.closeSync(logHandle);
  const stableTimer = setTimeout(() => {
    if (gatewayChild === child) gatewayRestartAttempts = 0;
  }, 30_000);
  stableTimer.unref();
  child.once('error', error => console.error('Could not start the Symbiote Gateway:', error));
  child.once('spawn', () => {
    try {
      writeGatewayProcessRecord({
        pid: child.pid,
        daemonPath: gateway.daemonPath,
        configPath: gateway.configPath,
      });
    } catch (error) {
      console.error('Could not persist the Gateway process record; stopping the untracked child:', error);
      child.kill('SIGTERM');
    }
  });
  child.once('exit', (code, signal) => {
    clearTimeout(stableTimer);
    try {
      const recorded = JSON.parse(fs.readFileSync(gatewayProcessPath, 'utf8'));
      if (recorded.pid === child.pid) fs.rmSync(gatewayProcessPath, { force: true });
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('Could not clear the exited Gateway process record:', error);
    }
    if (gatewayChild === child) gatewayChild = undefined;
    if (electronQuitting || gatewayStopping) return;
    gatewayRestartAttempts++;
    const delay = Math.min(1000 * (2 ** Math.min(gatewayRestartAttempts - 1, 6)), 60_000);
    console.error(`Symbiote Gateway exited (code ${code ?? 'none'}, signal ${signal ?? 'none'}); retrying in ${Math.ceil(delay / 1000)}s (attempt ${gatewayRestartAttempts}).`);
    gatewayRestartTimer = setTimeout(() => {
      gatewayRestartTimer = undefined;
      void ensureGateway().catch(error => {
        console.error('Could not restart the Symbiote Gateway:', error);
      });
    }, delay);
  });
  gatewayChild = child;
  return child;
}

async function ensureGateway() {
  if (gatewayStartup) return gatewayStartup;
  if (gatewayRestartTimer) clearTimeout(gatewayRestartTimer);
  gatewayRestartTimer = undefined;
  gatewayStartup = (async () => {
    if (electronQuitting) throw new Error('Electron is closing and will not start another Gateway process.');
    const gateway = readGatewayConfig();
    const installedServiceState = serviceState();
    serviceManagedGateway = installedServiceState !== undefined;
    if (serviceManagedGateway) {
      if (installedServiceState === 'STOPPED') {
        try {
          await execFileAsync('sc.exe', ['start', 'SymbioteGateway'], { windowsHide: true, timeout: 15_000 });
        } catch (error) {
          const currentState = serviceState();
          if (currentState !== 'RUNNING') {
            throw new Error(`The installed SymbioteGateway service is ${currentState ?? 'unavailable'} and could not be started: ${error.message}`);
          }
        }
      } else if (installedServiceState !== 'RUNNING' && installedServiceState !== 'START_PENDING') {
        throw new Error(`The installed SymbioteGateway service is in state ${installedServiceState}; refusing to launch a second Gateway.`);
      }
      if (!await waitForGateway(gateway, 60_000)) {
        throw new Error(`The installed SymbioteGateway service did not become healthy at ${gateway.url}/api/status. Review its Windows service logs.`);
      }
      return gateway;
    }

    const liveStatus = await readGatewayJson(gateway, '/api/status');
    if (liveStatus && Number.isInteger(liveStatus.pid)) {
      if (gatewayChild?.pid === liveStatus.pid) return gateway;
      const liveConfig = await readGatewayJson(gateway, '/api/config');
      const sameWorkspace = typeof liveConfig?.workspace === 'string'
        && path.resolve(liveConfig.workspace) === gateway.workspace;
      if (!sameWorkspace || !managedGatewayProcess(liveStatus.pid, gateway)) {
        throw new Error(`Port ${gateway.port} is serving a Gateway Electron cannot safely identify. It was left untouched.`);
      }
      await stopGatewayProcess(liveStatus.pid, gateway);
      const stopDeadline = Date.now() + 10_000;
      while (Date.now() < stopDeadline && await gatewayHealthCheck(gateway)) {
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (await gatewayHealthCheck(gateway)) {
        throw new Error(`The old Gateway process ${liveStatus.pid} did not release port ${gateway.port}.`);
      }
    }

    await stopStaleManagedGateway(gateway);
    if (await gatewayPortInUse(gateway)) {
      throw new Error(`Port ${gateway.port} is occupied by a process that is not a healthy Gateway managed by Electron. It was left untouched to avoid terminating an unrelated process.`);
    }
    const child = launchGateway(gateway);
    if (!await waitForGateway(gateway)) {
      if (child.pid && child.exitCode === null) child.kill();
      throw new Error(`The Gateway process did not become healthy at ${gateway.url}/api/status. See ${path.join(app.getPath('userData'), 'logs', 'gateway.log')}.`);
    }
    const startedStatus = await readGatewayJson(gateway, '/api/status');
    if (startedStatus?.pid !== child.pid) {
      throw new Error(`Port ${gateway.port} became healthy, but it is not served by the Gateway child Electron started.`);
    }
    return gateway;
  })();
  try {
    return await gatewayStartup;
  } finally {
    gatewayStartup = undefined;
  }
}

async function stopManagedGateway() {
  if (gatewayRestartTimer) clearTimeout(gatewayRestartTimer);
  gatewayRestartTimer = undefined;
  const child = gatewayChild;
  if (!child || child.exitCode !== null) return;
  gatewayStopping = true;
  child.kill('SIGTERM');
  await Promise.race([
    once(child, 'exit').catch(() => {}),
    new Promise(resolve => setTimeout(resolve, 8000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    if (process.platform === 'win32' && child.pid) {
      try {
        await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      } catch (error) {
        if (child.exitCode === null && child.signalCode === null && error.code !== 'ESRCH' && error.code !== 'ENOENT') throw error;
      }
    } else {
      child.kill('SIGKILL');
    }
  }
  if (child.exitCode === null && child.signalCode === null) {
    await Promise.race([
      once(child, 'exit').catch(() => {}),
      new Promise(resolve => setTimeout(resolve, 3000)),
    ]);
  }
  if (child.exitCode === null && child.signalCode === null) {
    gatewayStopping = false;
    throw new Error(`The Symbiote Gateway process ${child.pid ?? '(unknown PID)'} did not exit.`);
  }
  gatewayChild = undefined;
  gatewayStopping = false;
}

async function restartManagedGateway() {
  if (gatewayRestarting) return;
  gatewayRestarting = true;
  try {
    while (gatewayMonitorRunning) await new Promise(resolve => setTimeout(resolve, 100));
    if (serviceManagedGateway) {
      try {
        await execFileAsync('sc.exe', ['stop', 'SymbioteGateway'], { windowsHide: true, timeout: 15_000 });
      } catch (error) {
        const currentState = serviceState();
        if (currentState !== 'STOPPED' && currentState !== 'STOP_PENDING') {
          throw new Error(`Could not stop the installed SymbioteGateway service: ${error.message}`);
        }
      }
      const stopDeadline = Date.now() + 30_000;
      while (Date.now() < stopDeadline && serviceState() !== 'STOPPED') {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      if (serviceState() !== 'STOPPED') throw new Error('The installed SymbioteGateway service did not stop; no replacement process was started.');
      serviceManagedGateway = false;
      await ensureGateway();
      return;
    }
    if (gatewayChild && gatewayChild.exitCode === null) await stopManagedGateway();
    gatewayRestartAttempts = 0;
    await ensureGateway();
  } finally {
    gatewayRestarting = false;
  }
}

function startGatewayMonitor() {
  if (gatewayMonitorTimer) clearInterval(gatewayMonitorTimer);
  gatewayMonitorTimer = setInterval(async () => {
    if (electronQuitting || gatewayStartup || gatewayRestarting || gatewayStopping || gatewayMonitorRunning) return;
    gatewayMonitorRunning = true;
    try {
      const gateway = readGatewayConfig();
      if (await gatewayHealthCheck(gateway)) return;
      if (serviceManagedGateway) {
        const currentState = serviceState();
        if (currentState === 'STOPPED') {
          void ensureGateway().catch(error => console.error('Could not recover the Gateway service:', error));
        } else if (currentState === 'RUNNING') {
          console.error(`The SymbioteGateway service is running but its status endpoint is unavailable at ${gateway.url}/api/status.`);
        }
        return;
      }
      if (gatewayChild && gatewayChild.exitCode === null) await stopManagedGateway();
      gatewayRestartAttempts = 0;
      await ensureGateway();
    } catch (error) {
      console.error('The Gateway health monitor could not restore a healthy Gateway:', error);
    } finally {
      gatewayMonitorRunning = false;
    }
  }, 15_000);
  gatewayMonitorTimer.unref();
}

function hasFirewallRule(port) {
  try {
    execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', firewallScriptPath(), '-Port', String(port), '-CheckOnly',
    ], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch (error) {
    if (error.status !== 1) console.error('Could not verify the Symbiote firewall rule:', error);
    return false;
  }
}

function saveDesktopPreferences() {
  try {
    fs.writeFileSync(preferencesPath, JSON.stringify({
      overlayOpacity,
      ...(desktopTheme ? { desktopTheme } : {}),
      ...(declinedFirewallPort ? { declinedFirewallPort } : {}),
    }), 'utf8');
  } catch (error) {
    console.error('Could not save desktop preferences:', error);
  }
}

async function configureLanAccess(forcePrompt = false) {
  if (process.platform !== 'win32') return { status: 'unsupported' };
  const { host, port } = readGatewaySettings();
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError(`Invalid configured web port: ${port}`);
  if (isLoopbackHost(host)) return { status: 'loopback' };
  if (!forcePrompt && declinedFirewallPort === port) return { status: 'declined' };
  if (hasFirewallRule(port)) {
    declinedFirewallPort = undefined;
    saveDesktopPreferences();
    return { status: 'configured' };
  }

  const answer = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    title: 'Allow Symbiote on your local network?',
    message: 'Let other devices on your local network open the Symbiote Control Room?',
    detail: `This adds a Windows Firewall rule for TCP port ${port} on Domain and Private networks only. The rule is limited to your local subnet. Declining keeps Symbiote working on this computer.`,
    buttons: ['Allow local network access', 'Keep access on this computer'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (answer.response !== 0) {
    declinedFirewallPort = port;
    saveDesktopPreferences();
    return { status: 'declined' };
  }

  try {
    await execFileAsync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', firewallScriptPath(), '-Port', String(port),
    ], { windowsHide: true });
    declinedFirewallPort = undefined;
    saveDesktopPreferences();
    return { status: 'configured' };
  } catch (error) {
    declinedFirewallPort = port;
    saveDesktopPreferences();
    console.error('Could not configure the Symbiote firewall rule:', error);
    await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Firewall rule not changed',
      message: 'Windows Firewall was not changed. Symbiote is still available on this computer.',
      detail: 'You can grant local-network access later from Configuration in the desktop app.',
      buttons: ['OK'],
      noLink: true,
    });
    return { status: 'unavailable' };
  }
}

function getGatewayUrl() {
  if (isDesktopDev) return isDesktopDev.replace(/\/$/, '');
  return readGatewayConfig().url;
}

function rendererUrl(minimal) {
  const url = new URL(getGatewayUrl());
  url.searchParams.set('desktop', '1');
  if (minimal) url.searchParams.set('minimal', '1');
  return url.toString();
}

function loadGatewayWithRetry(target, minimal) {
  const gatewayUrl = rendererUrl(minimal);
  let attempt = 0;
  let retryTimer;
  let closed = false;
  const scheduleRetry = () => {
    if (closed || target.isDestroyed() || retryTimer) return;
    const delay = Math.min(1000 * (2 ** Math.min(attempt, 4)), 15000);
    attempt++;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      load();
    }, delay);
  };
  const load = () => {
    if (closed || target.isDestroyed()) return;
    void target.loadURL(gatewayUrl).catch(error => {
      console.error('Could not load the Symbiote Gateway UI; retrying:', error);
      scheduleRetry();
    });
  };
  target.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    console.error(`Symbiote Gateway page load failed (${errorCode}): ${errorDescription}`);
    scheduleRetry();
  });
  target.webContents.on('did-finish-load', () => {
    if (target.webContents.getURL() !== gatewayUrl) return;
    attempt = 0;
    clearTimeout(retryTimer);
    retryTimer = undefined;
  });
  target.once('closed', () => {
    closed = true;
    clearTimeout(retryTimer);
  });
  load();
}

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor: desktopTheme === 'dark' ? '#000000' : desktopTheme === 'light' ? '#ffffff' : nativeTheme.shouldUseDarkColors ? '#000000' : '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (process.platform === 'win32') void configureLanAccess();
  });
  mainWindow.on('close', event => {
    if (electronQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });
  mainWindow.webContents.session.on('will-download', (event, item) => {
    if (!updateInstallArmed) return;
    const downloadUrl = new URL(item.getURL());
    const gatewayUrl = new URL(getGatewayUrl());
    const filename = item.getFilename();
    if (updateInstallTimer) clearTimeout(updateInstallTimer);
    updateInstallTimer = undefined;
    if (downloadUrl.origin !== gatewayUrl.origin || downloadUrl.pathname !== '/api/update/installer'
      || !/^Symbiote-\d+\.\d+\.\d+-x64\.msi$/.test(filename)) {
      item.cancel();
      finishUpdateInstall(false);
      console.error('Rejected an unexpected download while an update install was armed.');
      return;
    }

    const installerPath = path.join(app.getPath('temp'), `symbiote-update-${Date.now()}-${filename}`);
    item.setSavePath(installerPath);
    item.once('done', async (_downloadEvent, state) => {
      if (state !== 'completed') {
        fs.rmSync(installerPath, { force: true });
        finishUpdateInstall(false);
        if (state !== 'cancelled') console.error(`Symbiote update download ended with state: ${state}`);
        return;
      }
      try {
        const status = await new Promise((resolve, reject) => {
          http.get(`${getGatewayUrl()}/api/status`, response => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => {
              try {
                if (response.statusCode !== 200) throw new Error(`Gateway update status returned HTTP ${response.statusCode}.`);
                resolve(JSON.parse(body));
              } catch (error) {
                reject(error);
              }
            });
          }).once('error', reject);
        });
        const expected = status.update?.download;
        if (expected?.state !== 'ready' || expected.filename !== filename || !/^[a-f0-9]{64}$/.test(expected.sha256 || '')) {
          throw new Error('Gateway no longer has the matching verified update package staged.');
        }
        const actualHash = await new Promise((resolve, reject) => {
          const hash = crypto.createHash('sha256');
          const stream = fs.createReadStream(installerPath);
          stream.on('error', reject);
          stream.on('data', chunk => hash.update(chunk));
          stream.on('end', () => resolve(hash.digest('hex')));
        });
        if (!crypto.timingSafeEqual(Buffer.from(actualHash, 'hex'), Buffer.from(expected.sha256, 'hex'))) {
          throw new Error('The downloaded installer failed its SHA-256 verification.');
        }
        const answer = await dialog.showMessageBox(mainWindow, {
          type: 'question',
          title: 'Install Symbiote update?',
          message: `Install Symbiote ${expected.version}?`,
          detail: 'The verified Windows installer will open. Windows may request administrator approval, and the Gateway may be unavailable briefly during the update.',
          buttons: ['Install update', 'Cancel'],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        });
        if (answer.response !== 0) {
          fs.rmSync(installerPath, { force: true });
          finishUpdateInstall(false);
          return;
        }
        const installer = spawn('msiexec.exe', ['/i', installerPath], {
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
        });
        installer.once('error', error => {
          finishUpdateInstall(false);
          console.error('Could not launch the Symbiote update installer:', error);
          dialog.showErrorBox('Update installer could not start', error.message);
        });
        installer.once('spawn', () => {
          installer.unref();
          finishUpdateInstall(true);
          app.quit();
        });
      } catch (error) {
        fs.rmSync(installerPath, { force: true });
        finishUpdateInstall(false);
        console.error('Could not verify the downloaded Symbiote update:', error);
        dialog.showErrorBox('Symbiote update failed', error.message);
      }
    });
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  loadGatewayWithRetry(mainWindow, false);
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    void ensureGateway().then(createMainWindow).catch(error => {
      console.error('Electron cannot show the Control Room:', error);
      dialog.showErrorBox('Symbiote Gateway unavailable', error.message);
    });
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  if (tray) return;
  const icon = nativeImage.createFromPath(path.join(__dirname, 'tray-icon.png'));
  if (icon.isEmpty()) throw new Error('The Symbiote system-tray icon could not be loaded.');
  tray = new Tray(icon);
  tray.setToolTip('Symbiote');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Symbiote', click: showMainWindow },
    { label: 'Restart Gateway', click: () => {
      void restartManagedGateway().catch(error => {
        console.error('Could not restart the Symbiote Gateway:', error);
        dialog.showErrorBox('Gateway restart failed', error.message);
      });
    } },
    { type: 'separator' },
    { label: 'Quit Symbiote', click: () => app.quit() },
  ]));
  tray.on('click', showMainWindow);
  tray.on('double-click', showMainWindow);
}

function closeDesktopControl() {
  desktopControlServer?.close();
  desktopControlServer = undefined;
  if (!desktopControlPath) return;
  try {
    const record = JSON.parse(fs.readFileSync(desktopControlPath, 'utf8'));
    if (record.pid === process.pid) fs.rmSync(desktopControlPath, { force: true });
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Could not clear the desktop control record:', error);
  }
}

function createMiniWindow() {
  if (miniWindow) {
    miniWindow.show();
    miniWindow.focus();
    return;
  }
  miniWindow = new BrowserWindow({
    width: 380,
    height: 600,
    minWidth: 320,
    minHeight: 360,
    maxWidth: 520,
    maxHeight: 900,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    resizable: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  miniWindow.setOpacity(overlayOpacity);
  miniWindow.once('ready-to-show', () => miniWindow.show());
  miniWindow.on('closed', () => {
    miniWindow = null;
    if (mainWindow) mainWindow.show();
  });
  loadGatewayWithRetry(miniWindow, true);
}

ipcMain.handle('desktop:open-mini', () => {
  mainWindow?.hide();
  createMiniWindow();
});
ipcMain.handle('desktop:expand', () => {
  miniWindow?.close();
  if (mainWindow) mainWindow.show();
  else createMainWindow();
});
ipcMain.handle('desktop:get-opacity', () => overlayOpacity);
ipcMain.handle('desktop:set-opacity', (_event, value) => {
  const opacity = Number(value);
  if (!Number.isFinite(opacity) || opacity < 0.35 || opacity > 1) {
    throw new RangeError('Overlay opacity must be between 0.35 and 1.');
  }
  overlayOpacity = opacity;
  saveDesktopPreferences();
  miniWindow?.setOpacity(overlayOpacity);
  return opacity;
});
ipcMain.handle('desktop:set-theme', (_event, theme) => {
  if (theme !== 'dark' && theme !== 'light') throw new TypeError('Desktop theme must be "dark" or "light".');
  desktopTheme = theme;
  nativeTheme.themeSource = theme;
  mainWindow?.setBackgroundColor(theme === 'dark' ? '#000000' : '#ffffff');
  saveDesktopPreferences();
  return desktopTheme;
});
ipcMain.handle('desktop:request-lan-access', () => configureLanAccess(true));
ipcMain.handle('desktop:request-reboot', async () => {
  if (process.platform !== 'win32') throw new Error('A confirmed system restart is currently available only in the Windows desktop app.');
  const script = 'Start-Process -FilePath "$env:SystemRoot\\System32\\shutdown.exe" -ArgumentList \'/r /t 15 /c "Restart requested from Symbiote"\' -Verb RunAs -ErrorAction Stop';
  try {
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      timeout: 15_000,
    });
  } catch (error) {
    throw new Error(`Windows did not accept the restart request: ${error.message}`);
  }
});
ipcMain.handle('desktop:install-update', () => {
  if (process.platform !== 'win32') throw new Error('In-app installation is currently supported only by the Windows desktop app.');
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error('The Symbiote Control Room is not open.');
  if (updateInstallArmed) throw new Error('An update download is already in progress.');
  return new Promise(resolve => {
    updateInstallArmed = true;
    resolveUpdateInstall = resolve;
    updateInstallTimer = setTimeout(() => finishUpdateInstall(false), 30_000);
    updateInstallTimer.unref();
    try {
      mainWindow.webContents.downloadURL(`${getGatewayUrl()}/api/update/installer`);
    } catch (error) {
      finishUpdateInstall(false);
      throw error;
    }
  });
});
ipcMain.handle('desktop:close-mini', () => miniWindow?.close());
ipcMain.on('desktop:hover', (event, hovering) => {
  if (miniWindow && event.sender === miniWindow.webContents) miniWindow.setOpacity(hovering ? 1 : overlayOpacity);
});

app.whenReady().then(() => {
  if (!ownsSingleInstanceLock) return;
  nativeTheme.themeSource = desktopTheme || 'system';
  try {
    createTray();
  } catch (error) {
    console.error('Could not initialize the Symbiote system tray:', error);
    dialog.showErrorBox('Symbiote could not start', error.message);
    app.quit();
    return;
  }
  void startDesktopControl(readGatewayConfig()).then(() => ensureGateway()).then(() => {
    startGatewayMonitor();
    createMainWindow();
  }).catch(error => {
    console.error('Electron cannot start without a healthy Symbiote Gateway:', error);
    dialog.showErrorBox('Symbiote Gateway unavailable', error.message);
    app.quit();
  });
});
app.on('before-quit', event => {
  if (electronQuitting) return;
  electronQuitting = true;
  const finishQuit = () => {
    tray?.destroy();
    tray = undefined;
    if (gatewayMonitorTimer) clearInterval(gatewayMonitorTimer);
    gatewayMonitorTimer = undefined;
    closeDesktopControl();
  };
  if (!gatewayChild || gatewayChild.exitCode !== null) {
    finishQuit();
    return;
  }
  event.preventDefault();
  void stopManagedGateway().then(() => {
    finishQuit();
    app.quit();
  }).catch(error => {
    electronQuitting = false;
    console.error('Could not stop the Electron-managed Gateway cleanly:', error);
    try {
      createTray();
      startGatewayMonitor();
      void startDesktopControl(readGatewayConfig()).catch(controlError => {
        console.error('Could not restore the desktop control endpoint after shutdown failed:', controlError);
      });
    } catch (recoveryError) {
      console.error('Could not restore Symbiote to the system tray after shutdown failed:', recoveryError);
    }
    dialog.showErrorBox('Gateway shutdown failed', error.message);
  });
});
app.on('activate', () => {
  if (!ownsSingleInstanceLock) return;
  showMainWindow();
});
if (ownsSingleInstanceLock) {
  app.on('second-instance', () => {
    showMainWindow();
  });
} else {
  app.quit();
}
