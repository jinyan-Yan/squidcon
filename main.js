'use strict'

const { app, BrowserWindow, ipcMain, dialog, screen } = require('electron')
const path = require('path')
const fs = require('fs/promises')
const { convertImage } = require('./src/pipeline')

let win = null

const IMAGE_EXT = /\.(svg|png|jpe?g|webp)$/i

/** 启动时命令行传入的图片路径(资源管理器「打开方式」/ npm start -- xxx.png) */
function startupImagePaths() {
  const args = process.argv.slice(app.isPackaged ? 1 : 2)
  // portable 版会把自身解压到临时目录并切换工作目录,
  // 所以相对路径要按 exe 所在的真实目录来解析。
  const base = process.env.PORTABLE_EXECUTABLE_DIR || process.cwd()
  return args.filter((a) => IMAGE_EXT.test(a)).map((a) => path.resolve(base, a))
}

/** 把磁盘上的文件读成渲染进程能用的形状 */
async function readAsPayload(filePath) {
  const name = path.basename(filePath)
  if (/\.svg$/i.test(name)) {
    return { name, svg: await fs.readFile(filePath, 'utf8') }
  }
  return { name, bytes: await fs.readFile(filePath) }
}

function createWindow() {
  // 按可用工作区算尺寸。写死 1200×800 在 150% 缩放的 1080p 屏上会撑出屏幕外
  const { workAreaSize } = screen.getPrimaryDisplay()
  const width = Math.max(980, Math.min(1220, workAreaSize.width - 80))
  const height = Math.max(640, Math.min(840, workAreaSize.height - 80))

  win = new BrowserWindow({
    width,
    height,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#FAFAFA',
    title: '鱿鱼图标',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  // 页面加载失败 / 渲染进程崩溃时把原因打到控制台,
  // 否则打包后只会看到一个空白窗口,什么都不说。
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[IconForge] 页面加载失败 ${code} ${desc} — ${url}`)
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[IconForge] 渲染进程退出:', details.reason)
  })
  win.webContents.on('console-message', (...args) => {
    const detail = args[1]
    // 新版本 Electron 回传对象,老版本回传 (level, message, line, sourceId)
    if (detail && typeof detail === 'object') {
      if (detail.level === 'error' || detail.level === 'warning') {
        console.error(`[renderer] ${detail.message} (${detail.sourceId}:${detail.lineNumber})`)
      }
    } else if (args[1] >= 2) {
      console.error(`[renderer] ${args[2]} (${args[4]}:${args[3]})`)
    }
  })

  win.webContents.on('did-finish-load', async () => {
    const paths = startupImagePaths()
    if (paths.length === 0) return

    const files = []
    for (const p of paths) {
      try {
        files.push(await readAsPayload(p))
      } catch {
        /* 单个文件读失败不影响其他文件 */
      }
    }
    if (files.length > 0) win.webContents.send('boot:files', files)
  })

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

/* ------------------------------------------------------------------ *
 * IPC —— 渲染进程不能直接碰文件系统和 Node 模块,全部走这里
 * ------------------------------------------------------------------ */

/** IPC 传过来的 Uint8Array 转回 Buffer */
function toInput(payload) {
  if (!payload) return null
  if (payload.svg != null) return { svg: payload.svg }
  if (payload.bytes != null) return { buffer: Buffer.from(payload.bytes) }
  return null
}

// 把参考图的样式套到目标图上
ipcMain.handle('image:convert', async (_event, payload) => {
  try {
    const { target, reference, targetKey, referenceKey, outSize, format } = payload || {}
    return await convertImage({
      target: toInput(target),
      reference: toInput(reference),
      targetKey,
      referenceKey,
      outSize: outSize || 512,
      format: format || 'auto',
    })
  } catch (err) {
    return { ok: false, message: err.message }
  }
})

function ensureExt(name, format) {
  const ext = '.' + format
  return name.toLowerCase().endsWith(ext) ? name : name.replace(/\.[^.]+$/, '') + ext
}

function dataOf(file) {
  return file.format === 'svg' ? file.svg : Buffer.from(file.pngBase64, 'base64')
}

// 导出单个文件
ipcMain.handle('file:save', async (_event, file) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: '导出',
    defaultPath: ensureExt(file.name, file.format),
    filters: [{ name: file.format.toUpperCase(), extensions: [file.format] }],
  })
  if (canceled || !filePath) return { ok: false, canceled: true }

  await fs.writeFile(filePath, dataOf(file))
  return { ok: true, path: filePath }
})

// 导出全部到同一个文件夹
ipcMain.handle('file:saveAll', async (_event, { files }) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '选择导出文件夹',
    properties: ['openDirectory', 'createDirectory'],
  })
  if (canceled || filePaths.length === 0) return { ok: false, canceled: true }

  const dir = filePaths[0]
  for (const file of files) {
    await fs.writeFile(path.join(dir, ensureExt(file.name, file.format)), dataOf(file))
  }
  return { ok: true, dir, count: files.length }
})
