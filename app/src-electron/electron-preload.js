import { contextBridge, ipcRenderer } from 'electron'

const updateBadge = count => ipcRenderer.send('frank:update-badge', count)
contextBridge.exposeInMainWorld('badge', {
  updateBadge,
  setBadgeCount: updateBadge,
})

contextBridge.exposeInMainWorld('url', {
  open: url => ipcRenderer.send('frank:open-url', url),
})
