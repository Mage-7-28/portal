import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

// 设置自定义应用数据目录
const appDataDir = join(__dirname, '../appData')
if (!existsSync(appDataDir)) {
  mkdirSync(appDataDir, { recursive: true })
}
app.setPath('appData', appDataDir)

// 设置自定义用户数据目录
const userDataDir = join(__dirname, '../userData')
if (!existsSync(userDataDir)) {
  mkdirSync(userDataDir, { recursive: true })
}
app.setPath('userData', userDataDir)

// 设置自定义日志目录
const logsDir = join(__dirname, '../logs')
if (!existsSync(logsDir)) {
  mkdirSync(logsDir, { recursive: true })
}
app.setPath('logs', logsDir)

// 设置自定义临时文件目录
const tempDir = join(__dirname, '../temp')
if (!existsSync(tempDir)) {
  mkdirSync(tempDir, { recursive: true })
}
app.setPath('temp', tempDir)

// 设置自定义缓存目录
const cacheDir = join(__dirname, '../cache')
if (!existsSync(cacheDir)) {
  mkdirSync(cacheDir, { recursive: true })
}
app.setPath('cache', cacheDir)

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // 添加窗口关闭事件监听
  mainWindow.on('close', (e) => {
    // 阻止默认关闭行为
    e.preventDefault()

    // 显示确认弹窗
    dialog
      .showMessageBox({
        type: 'question',
        buttons: ['关闭', '取消'],
        title: '确认关闭',
        message: '确定要关闭应用程序吗？',
        defaultId: 1, // 默认选中取消按钮
        cancelId: 1 // 取消按钮的索引
      })
      .then((result) => {
        // 如果用户选择关闭（按钮索引0），则关闭窗口并退出应用
        if (result.response === 0) {
          // 关闭当前窗口
          mainWindow.destroy()
          // 退出应用
          app.quit()
        }
        // 否则，保持窗口打开
      })
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
