'use strict'

/**
 * 往运行中的应用里灌图片,并在指定时刻截图,用来验证过渡动画。
 *
 * 前提:应用以 --remote-debugging-port=9222 启动
 * 用法: node test/cdp-load.js <等待毫秒> <输出文件> <图片1> [图片2 ...]
 */

const fs = require('fs')
const path = require('path')

const port = process.env.CDP_PORT || 9222
const waitMs = Number(process.argv[2] || 900)
const outFile = process.argv[3]
const files = process.argv.slice(4)

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  const page = targets.find((t) => t.type === 'page')
  if (!page) throw new Error('没有找到页面目标')

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let nextId = 1
  const pending = new Map()

  // CDP 偶尔不回包,加个超时免得脚本挂死
  const SEND_TIMEOUT = 20000
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = setTimeout(() => reject(new Error(method + ' 超时')), SEND_TIMEOUT)
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      ws.send(JSON.stringify({ id, method, params }))
    })

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
    }
  })

  const entries = files.map((f) => ({
    name: path.basename(f),
    b64: fs.readFileSync(f).toString('base64'),
  }))

  // 顶层函数声明会挂在 window 上,直接调 ingest 等价于用户拖入
  const expression = `
    (async () => {
      const entries = ${JSON.stringify(entries)}.map((e) => ({
        name: e.name,
        bytes: Uint8Array.from(atob(e.b64), (c) => c.charCodeAt(0)),
      }))
      ingest(entries)
      return 'ingested ' + entries.length
    })()
  `

  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  console.log('EVAL:', JSON.stringify(result.result && result.result.value))

  await new Promise((r) => setTimeout(r, waitMs))

  const shot = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(outFile, Buffer.from(shot.data, 'base64'))
  console.log('SAVED', outFile, `after ${waitMs}ms`)

  ws.close()
  process.exit(0)
}

main().catch((e) => {
  console.error('失败:', e.message)
  process.exit(1)
})
