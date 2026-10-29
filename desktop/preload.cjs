const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('symbioteDesktop', Object.freeze({
  supportsReboot: process.platform === 'win32',
  openMini: () => ipcRenderer.invoke('desktop:open-mini'),
  expand: () => ipcRenderer.invoke('desktop:expand'),
  closeMini: () => ipcRenderer.invoke('desktop:close-mini'),
  restartApp: () => ipcRenderer.invoke('desktop:restart-app'),
  getLanUrl: () => ipcRenderer.invoke('desktop:get-lan-url'),
  getOpacity: () => ipcRenderer.invoke('desktop:get-opacity'),
  setOpacity: (opacity) => ipcRenderer.invoke('desktop:set-opacity', opacity),
  setTheme: (theme) => ipcRenderer.invoke('desktop:set-theme', theme),
  requestLanAccess: () => ipcRenderer.invoke('desktop:request-lan-access'),
  requestReboot: () => ipcRenderer.invoke('desktop:request-reboot'),
  installUpdate: () => ipcRenderer.invoke('desktop:install-update'),
}));

window.addEventListener('mouseenter', () => ipcRenderer.send('desktop:hover', true));
window.addEventListener('mouseleave', () => ipcRenderer.send('desktop:hover', false));
