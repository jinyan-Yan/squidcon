'use strict'

/**
 * 把文件作为 asset 上传到指定的 GitHub Release。
 *
 * 用法(令牌从环境变量取,不写进文件):
 *   TOKEN=xxx RELEASE_ID=123 node test/upload-release.js <文件>
 */

const fs = require('fs')
const path = require('path')

const token = process.env.TOKEN
const releaseId = process.env.RELEASE_ID
const file = process.argv[2]

if (!token || !releaseId || !file) {
  console.error('缺少参数:需要环境变量 TOKEN / RELEASE_ID 和文件路径')
  process.exit(1)
}
if (!fs.existsSync(file)) {
  console.error('文件不存在:', file)
  process.exit(1)
}

const name = path.basename(file)
const size = fs.statSync(file).size

async function main() {
  const url = `https://uploads.github.com/repos/jinyan-Yan/squidcon/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`
  console.log(`上传 ${name}(${(size / 1024 / 1024).toFixed(1)} MB)...`)

  const started = Date.now()
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(size),
    },
    body: fs.createReadStream(file),
    duplex: 'half',
  })

  const data = await res.json()
  const secs = ((Date.now() - started) / 1000).toFixed(1)

  if (res.status >= 200 && res.status < 300) {
    console.log(`✅ 完成 ${secs}s  ${(size / 1024 / 1024 / secs).toFixed(2)} MB/s`)
    console.log('下载地址:', data.browser_download_url)
  } else {
    console.error(`❌ 状态 ${res.status} ${secs}s`)
    console.error(data.message || JSON.stringify(data))
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('失败:', e.message)
  process.exit(1)
})
