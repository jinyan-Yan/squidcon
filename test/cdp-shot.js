'use strict'

/**
 * 通过 Chrome DevTools Protocol 直接截页面内容。
 * 比 OS 层的 PrintWindow 可靠 —— 不受窗口遮挡、DPI、GPU 合成影响。
 *
 * 前提:应用以 --remote-debugging-port=9222 启动
 * 用法: node test/cdp-shot.js <输出文件> [要 evaluate 的表达式]
 */

const fs = require('fs')

const port = process.env.CDP_PORT || 9222
const outFile = process.argv[2] || 'test/cdp.png'
const expression = process.argv[3] || null

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

  if (expression) {
    const result = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    console.log('EVAL:', JSON.stringify(result.result && result.result.value, null, 2))
  }

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  fs.writeFileSync(outFile, Buffer.from(shot.data, 'base64'))
  console.log('SAVED', outFile)

  ws.close()
  process.exit(0)
}

main().catch((e) => {
  console.error('失败:', e.message)
  process.exit(1)
})
