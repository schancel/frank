/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable no-unused-vars */
import {
  app,
  BrowserWindow,
  nativeTheme,
  ipcMain,
  Tray,
  Menu,
  shell,
  nativeImage,
} from 'electron'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'
import Badge from 'electron-windows-badge'
import { registerQuasarRuntime } from '#q-app/electron/main'

const currentDir = fileURLToPath(new URL('.', import.meta.url))
const __dirname = currentDir

// Enable single instance lock
const isSingleInstance = app.requestSingleInstanceLock()
if (!isSingleInstance) {
  app.quit()
}

try {
  if (
    process.platform === 'win32' &&
    nativeTheme.shouldUseDarkColors === true
  ) {
    fs.unlinkSync(path.join(app.getPath('userData'), 'DevTools Extensions'))
  }
  // eslint-disable-next-line no-empty
} catch (_) {}

function getIconPNGPath() {
  const candidates = [
    path.join(currentDir, 'electron-assets/icons/linux-512x512.png'),
    path.join(currentDir, 'icons/icon-512x512.png'),
    path.join(currentDir, 'icons/linux-512x512.png'),
    path.join(currentDir, '../icons/linux-512x512.png'),
    path.join(currentDir, '../electron-assets/icons/linux-512x512.png'),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return path.join(currentDir, 'icons/icon-512x512.png')
}

let mainWindow
let tray
let windowsBadgeUpdater
const nativeIconSmall = nativeImage
  .createFromPath(getIconPNGPath())
  .resize({ width: 16, height: 16 })
const nativeIcon = nativeImage.createFromPath(getIconPNGPath())

async function createWindow() {
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open Frank',
      click: function () {
        mainWindow.show()
      },
    },
    {
      label: 'Quit Frank',
      click: function () {
        mainWindow.destroy()
        app.quit()
      },
    },
  ])

  tray = new Tray(nativeIconSmall)
  tray.setContextMenu(contextMenu)

  mainWindow = new BrowserWindow({
    width: 1000,
    height: 600,
    icon: nativeIcon,
    useContentSize: true,
    webPreferences: {
      preload: path.resolve(__dirname, 'electron-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  if (process.platform === 'win32') {
    windowsBadgeUpdater = new Badge(mainWindow, {})
  }

  if (import.meta.env.QUASAR_DEV) {
    await mainWindow.loadURL(import.meta.env.QUASAR_APP_URL)
  } else {
    await mainWindow.loadFile(path.join(currentDir, 'index.html'))
  }

  let forceQuit = false
  if (process.platform === 'darwin') {
    app.on('before-quit', function () {
      forceQuit = true
    })
  }

  mainWindow.on('close', function (event) {
    if (forceQuit) {
      return
    }
    event.preventDefault()
    mainWindow.hide()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url !== e.sender.getURL()) {
      e.preventDefault()
      openExternal(url)
    }
  })
}

app.on('second-instance', (event, commandLine, workingDirectory) => {
  // Someone tried to run a second instance, we should focus our window.
  if (mainWindow) {
    mainWindow.show()
    mainWindow.focus()
  }
})

function openExternal(url) {
  if (typeof url !== 'string') return
  try {
    const parsed = new URL(url)
    if (['https:', 'http:', 'mailto:'].includes(parsed.protocol)) {
      void shell.openExternal(parsed.href)
    }
  } catch {
    // Ignore malformed external URLs instead of passing them to the operating system.
  }
}

app.whenReady().then(() => {
  registerQuasarRuntime()
  ipcMain.on('frank:update-badge', (event, count) => {
    if (
      event.sender !== mainWindow?.webContents ||
      !Number.isSafeInteger(count) ||
      count < 0
    )
      return
    if (process.platform === 'win32') windowsBadgeUpdater?.update(count)
    else app.setBadgeCount(count)
  })
  ipcMain.on('frank:open-url', (event, url) => {
    if (event.sender === mainWindow?.webContents) openExternal(url)
  })
  void createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow()
  }
})
