const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const isDesktopDev = process.env.SYMBIOTE_DESKTOP_URL;
let mainWindow;
let miniWindow;
let overlayOpacity = 0.88;
const preferencesPath = path.join(app.getPath('userData'), 'desktop-preferences.json');

try {
  const preferences = JSON.parse(fs.readFileSync(preferencesPath, 'utf8'));
  if (Number.isFinite(preferences.overlayOpacity) && preferences.overlayOpacity >= 0.35 && preferences.overlayOpacity <= 1) {
    overlayOpacity = preferences.overlayOpacity;
  }
} catch (error) {
  if (error.code !== 'ENOENT') console.error('Could not read desktop preferences:', error);
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
  mainWindow.once('ready-to-show', () => mainWindow.show());
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
  fs.writeFileSync(preferencesPath, JSON.stringify({ overlayOpacity }), 'utf8');
  miniWindow?.setOpacity(1);
  return opacity;
});
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
