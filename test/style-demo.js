'use strict'

/**
 * 命令行验证样式转换:
 *   node test/style-demo.js <目标图> <参考图> <输出图>
 *
 * 参考图留 "-" 表示不套参考样式(走默认:透明画布、无底板、内容占 80%)
 */

const fs = require('fs')
const path = require('path')
const { convertImage } = require('../src/pipeline')

async function load(file) {
  const buffer = fs.readFileSync(file)
  return /\.svg$/i.test(file) ? { svg: buffer.toString('utf8') } : { buffer }
}

;(async () => {
  const [targetPath, refPath, outPath] = process.argv.slice(2)
  if (!targetPath || !outPath) {
    console.log('用法: node test/style-demo.js <目标图> <参考图|-> <输出图>')
    process.exit(1)
  }

  const target = await load(targetPath)
  const reference = refPath && refPath !== '-' ? await load(refPath) : null

  const started = Date.now()
  const result = await convertImage({ target, reference, outSize: 512 })

  if (result.format === 'svg') {
    fs.writeFileSync(outPath.endsWith('.svg') ? outPath : outPath + '.svg', result.svg)
  } else {
    fs.writeFileSync(
      outPath.endsWith('.png') ? outPath : outPath + '.png',
      Buffer.from(result.pngBase64, 'base64')
    )
  }

  console.log(`\n目标 : ${path.basename(targetPath)}`)
  console.log(`参考 : ${reference ? path.basename(refPath) : '(无,默认样式)'}`)
  console.log(`耗时 : ${Date.now() - started}ms`)
  console.log('\n源图结构:')
  console.log(`  画布        : ${result.report.source.canvasTransparent ? '透明' : '实色'}`)
  console.log(`  底板        : ${result.report.source.hasTile ? `${result.report.source.tileColor} 圆角比 ${result.report.source.radiusRatio}` : '无'}`)
  console.log(`  内容占画布  : ${(result.report.source.contentRatio * 100).toFixed(1)}%`)
  console.log('\n套用后的样式:')
  console.log(`  画布        : ${result.report.applied.canvasTransparent ? '透明' : result.report.applied.canvasColor}`)
  console.log(`  底板        : ${result.report.applied.hasTile ? `${result.report.applied.tileColor} 圆角比 ${result.report.applied.radiusRatio}` : '无'}`)
  console.log(`  内容占画布  : ${(result.report.applied.contentRatio * 100).toFixed(1)}%`)
  console.log(`\n输出: ${outPath} (${result.format})`)
})().catch((e) => {
  console.error('失败:', e.stack || e.message)
  process.exit(1)
})
