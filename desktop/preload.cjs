const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('symbioteDesktop', Object.freeze({
  openMini: () => ipcRenderer.invoke('desktop:open-mini'),
  expand: () => ipcRenderer.invoke('desktop:expand'),
  closeMini: () => ipcRenderer.invoke('desktop:close-mini'),
  getOpacity: () => ipcRenderer.invoke('desktop:get-opacity'),
  setOpacity: (opacity) => ipcRenderer.invoke('desktop:set-opacity', opacity),
  requestLanAccess: () => ipcRenderer.invoke('desktop:request-lan-access'),
}));

window.addEventListener('mouseenter', () => ipcRenderer.send('desktop:hover', true));
window.addEventListener('mouseleave', () => ipcRenderer.send('desktop:hover', false));
