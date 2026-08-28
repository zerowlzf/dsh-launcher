// DSH 启动器 — preload：向渲染层暴露最小 API
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('launcher', {
  getState: () => ipcRenderer.invoke('launcher:getState'),
  onStatus: (cb) => {
    const listener = (_e, s) => cb(s)
    ipcRenderer.on('launcher:status', listener)
    return () => ipcRenderer.removeListener('launcher:status', listener)
  },
  openBrowser: () => ipcRenderer.invoke('launcher:openBrowser'),
  openExternal: (url) => ipcRenderer.invoke('launcher:openExternal', url),
  retry: () => ipcRenderer.invoke('launcher:retry'),
  stopDsh: () => ipcRenderer.invoke('launcher:stopDsh'),
  copyLog: () => ipcRenderer.invoke('launcher:copyLog'),
})
