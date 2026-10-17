import { contextBridge, ipcRenderer } from 'electron'

const updateBadge = count => ipcRenderer.send('app:update-badge', count)
contextBridge.exposeInMainWorld('badge', {
  updateBadge,
  setBadgeCount: updateBadge,
})

contextBridge.exposeInMainWorld('url', {
  open: url => ipcRenderer.send('app:open-url', url),
})
