const { app, BrowserWindow, dialog, ipcMain, nativeTheme } = require('electron');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');

const execFileAsync = promisify(execFile);
const isDesktopDev = process.env.SYMBIOTE_DESKTOP_URL;
let mainWindow;
let miniWindow;
let overlayOpacity = 0.88;
let declinedFirewallPort;
const preferencesPath = path.join(app.getPath('userData'), 'desktop-preferences.json');

try {
  const preferences = JSON.parse(fs.readFileSync(preferencesPath, 'utf8'));
  if (Number.isFinite(preferences.overlayOpacity) && preferences.overlayOpacity >= 0.35 && preferences.overlayOpacity <= 1) {
    overlayOpacity = preferences.overlayOpacity;
  }
  if (Number.isInteger(preferences.declinedFirewallPort)) declinedFirewallPort = preferences.declinedFirewallPort;
} catch (error) {
  if (error.code !== 'ENOENT') console.error('Could not read desktop preferences:', error);
}

function readGatewaySettings() {
  const candidates = [path.join(process.cwd(), 'symbiote.json')];
  if (process.platform === 'win32') {
    try {
      const registry = execFileSync('reg.exe', ['query', 'HKLM\\Software\\Artifact Virtual\\Symbiote', '/v', 'DataDirectory'], { encoding: 'utf8' });
      const dataDirectory = registry.match(/DataDirectory\s+REG_SZ\s+(.+)/i)?.[1]?.trim();
      if (dataDirectory) candidates.push(path.join(dataDirectory, 'symbiote.json'));
    } catch (error) {
      if (error.status !== 1 && error.code !== 'ENOENT') console.error('Could not read the Symbiote data directory from the registry:', error);
    }
  }
  for (const file of candidates) {
    try {
      const config = JSON.parse(fs.readFileSync(file, 'utf8'));
      const envFile = path.join(path.dirname(file), '.env');
      let configuredHost = '';
      try {
        const match = fs.readFileSync(envFile, 'utf8').match(/^\s*SYMBIOTE_WEB_HOST\s*=\s*["']?([^"'#\r\n]+)["']?\s*$/m);
        configuredHost = match?.[1]?.trim() ?? '';
      } catch (error) {
        if (error.code !== 'ENOENT') console.error(`Could not read desktop gateway environment ${envFile}:`, error);
      }
      return { host: process.env.SYMBIOTE_WEB_HOST || configuredHost || config.webHost || '0.0.0.0', port: Number(config.webPort) || 3009 };
    } catch (error) {
      if (error.code !== 'ENOENT') console.error(`Could not read desktop gateway config ${file}:`, error);
    }
  }
  return { host: process.env.SYMBIOTE_WEB_HOST || '0.0.0.0', port: 3009 };
}

function isLoopbackHost(host) {
  const normalized = String(host).trim().toLowerCase();
  return normalized === 'localhost' || normalized === '::1' || normalized === '127.0.0.1' || normalized.startsWith('127.');
}

function firewallScriptPath() {
  return path.join(__dirname, '..', 'scripts', 'windows', 'configure-firewall.ps1');
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
  const candidates = [path.join(process.cwd(), 'symbiote.json')];
  for (const file of candidates) {
    try {
      const config = JSON.parse(fs.readFileSync(file, 'utf8'));
      const host = config.webHost === '0.0.0.0' || config.webHost === '::' ? '127.0.0.1' : (config.webHost || '127.0.0.1');
      const port = Number(config.webPort) || 3009;
      return `http://${host}:${port}`;
    } catch (error) {
      if (error.code !== 'ENOENT') console.error(`Could not read desktop gateway config ${file}:`, error);
    }
  }
  try {
    const registry = execFileSync('reg.exe', ['query', 'HKLM\\Software\\Artifact Virtual\\Symbiote', '/v', 'WebPort'], { encoding: 'utf8' });
    const portMatch = registry.match(/WebPort\s+REG_DWORD\s+0x([0-9a-f]+)/i);
    const port = portMatch ? Number.parseInt(portMatch[1], 16) : 3009;
    if (port < 1 || port > 65535) throw new RangeError(`Invalid configured web port: ${port}`);
    return `http://127.0.0.1:${port}`;
  } catch (error) {
    if (error.status !== 1 && error.code !== 'ENOENT') console.error('Could not read the Symbiote web port from the registry:', error);
    return 'http://127.0.0.1:3009';
  }
}

function rendererUrl(minimal) {
  const url = new URL(getGatewayUrl());
  url.searchParams.set('desktop', '1');
  if (minimal) url.searchParams.set('minimal', '1');
  return url.toString();
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#111318' : '#f4f5f7',
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
  mainWindow.on('closed', () => {
    mainWindow = null;
    if (!miniWindow) app.quit();
  });
  void mainWindow.loadURL(rendererUrl(false));
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
    else app.quit();
  });
  void miniWindow.loadURL(rendererUrl(true));
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
  miniWindow?.setOpacity(1);
  return opacity;
});
ipcMain.handle('desktop:request-lan-access', () => configureLanAccess(true));
ipcMain.handle('desktop:close-mini', () => miniWindow?.close());
ipcMain.on('desktop:hover', (event, hovering) => {
  if (miniWindow && event.sender === miniWindow.webContents) miniWindow.setOpacity(hovering ? 1 : overlayOpacity);
});

app.whenReady().then(() => {
  nativeTheme.themeSource = 'system';
  createMainWindow();
});
app.on('activate', () => {
  if (!mainWindow && !miniWindow) createMainWindow();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
