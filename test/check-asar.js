'use strict'

/**
 * 验证安装包里的 app.asar 装的是不是当前这版代码。
 * 用法: node test/check-asar.js <app.asar 路径>
 */

const asar = require('@electron/asar')

const target = process.argv[2]
if (!target) {
  console.log('用法: node test/check-asar.js <app.asar 路径>')
  process.exit(1)
}

const list = asar.listPackage(target).map((s) => s.split('\\').join('/'))

const expected = [
  '/main.js',
  '/preload.js',
  '/src/probe.js',
  '/src/style.js',
  '/src/pipeline.js',
  '/renderer/index.html',
  '/renderer/app.js',
  '/renderer/style.css',
]

let missing = 0
for (const f of expected) {
  const ok = list.includes(f)
  if (!ok) missing++
  console.log(`${ok ? '✅' : '❌'} ${f}`)
}

// 旧版引擎不该再出现在包里
const legacy = list.filter((f) => f.includes('normalize.js'))
console.log(legacy.length ? `⚠️  残留旧文件: ${legacy.join(', ')}` : '✅ 没有旧版 normalize.js 残留')

const pipeline = asar.extractFile(target, 'src/pipeline.js').toString('utf8')
const hasReference = pipeline.includes('styleFromProbe') && pipeline.includes('reference')
console.log(hasReference ? '✅ pipeline 是新版(参考图驱动)' : '❌ pipeline 还是旧版')

process.exit(missing || !hasReference ? 1 : 0)
