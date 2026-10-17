const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('symbioteDesktop', Object.freeze({
  openMini: () => ipcRenderer.invoke('desktop:open-mini'),
  expand: () => ipcRenderer.invoke('desktop:expand'),
  closeMini: () => ipcRenderer.invoke('desktop:close-mini'),
  getOpacity: () => ipcRenderer.invoke('desktop:get-opacity'),
  setOpacity: (opacity) => ipcRenderer.invoke('desktop:set-opacity', opacity),
  setTheme: (theme) => ipcRenderer.invoke('desktop:set-theme', theme),
  requestLanAccess: () => ipcRenderer.invoke('desktop:request-lan-access'),
  installUpdate: () => ipcRenderer.invoke('desktop:install-update'),
}));

window.addEventListener('mouseenter', () => ipcRenderer.send('desktop:hover', true));
window.addEventListener('mouseleave', () => ipcRenderer.send('desktop:hover', false));
