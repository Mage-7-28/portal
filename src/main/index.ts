import { app, shell, BrowserWindow, ipcMain, dialog, Menu } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

// 设置自定义用户数据目录
// 其他目录（如cache、logs等）会默认作为userData的子目录
const userDataDir = join(__dirname, '../userData')
if (!existsSync(userDataDir)) {
  mkdirSync(userDataDir, { recursive: true })
}
app.setPath('userData', userDataDir)

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    title: '传送门',
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
    try {
      // 阻止默认关闭行为
      e.preventDefault()

      // 显示确认弹窗
      dialog
        .showMessageBox(mainWindow, {
          type: 'question',
          buttons: ['关闭', '取消'],
          title: '确认关闭',
          message: '确定要关闭应用程序吗？',
          icon: icon,
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
        .catch((error) => {
          console.error('关闭确认对话框错误:', error)
          // 如果对话框出错，直接退出应用
          mainWindow.destroy()
          app.quit()
        })
    } catch (error) {
      console.error('窗口关闭事件处理错误:', error)
      // 如果发生错误，直接退出应用
      mainWindow.destroy()
      app.quit()
    }
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
  electronApp.setAppUserModelId('com.portal')

  // 设置macOS系统信息
  if (process.platform === 'darwin') {
    // 设置应用关于面板选项
    app.setAboutPanelOptions({
      applicationName: '传送门',
      applicationVersion: app.getVersion(),
      credits: '电脑和服务器之间传输文件的传送门',
      iconPath: icon
    })
  }

  // 创建菜单模板
  const menuTemplate: Electron.MenuItemConstructorOptions[] = [
    {
      label: '文件'
    },
    {
      label: '传送门',
      submenu: [
        {
          label: '退出',
          accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Ctrl+Q',
          click: () => {
            app.quit()
          }
        }
      ]
    },
    {
      label: '编辑',
      submenu: [
        {
          label: '撤销',
          accelerator: process.platform === 'darwin' ? 'Cmd+Z' : 'Ctrl+Z',
          role: 'undo'
        },
        {
          label: '重做',
          accelerator: process.platform === 'darwin' ? 'Cmd+Shift+Z' : 'Ctrl+Shift+Z',
          role: 'redo'
        },
        { type: 'separator' },
        {
          label: '剪切',
          accelerator: process.platform === 'darwin' ? 'Cmd+X' : 'Ctrl+X',
          role: 'cut'
        },
        {
          label: '复制',
          accelerator: process.platform === 'darwin' ? 'Cmd+C' : 'Ctrl+C',
          role: 'copy'
        },
        {
          label: '粘贴',
          accelerator: process.platform === 'darwin' ? 'Cmd+V' : 'Ctrl+V',
          role: 'paste'
        },
        {
          label: '全选',
          accelerator: process.platform === 'darwin' ? 'Cmd+A' : 'Ctrl+A',
          role: 'selectAll'
        }
      ]
    },
    {
      label: '更多',
      submenu: [
        {
          label: '关于',
          click: () => {
            dialog.showMessageBox({
              title: '关于 传送门',
              message: '传送门',
              detail: '版本 ' + app.getVersion() + '\n电脑和服务器之间传输文件的工具',
              icon: icon,
              buttons: ['确定']
            })
          },
          role: 'about'
        }
      ]
    }
  ]

  // 构建菜单
  const menu = Menu.buildFromTemplate(menuTemplate)

  // 设置应用菜单
  Menu.setApplicationMenu(menu)

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
