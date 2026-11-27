'use strict'

/**
 * 拆解一张图的结构:画布 → 底板 → 主内容
 *
 * 注意:这里必须走 src/probe.js,和产品用同一个渲染器(resvg)。
 * sharp 内部的 librsvg 对某些 iconfont 导出的 SVG 会少渲染路径,
 * 用两套渲染器量同一张图会得出不一样的占比。
 *
 * 用法: node test/analyze.js 图片路径 [图片路径...]
 */

const fs = require('fs')
const { probe } = require('../src/probe')

const toHex = (rgb) =>
  rgb ? '#' + rgb.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase() : null

async function analyze(file) {
  const buffer = fs.readFileSync(file)
  const input = /\.svg$/i.test(file) ? { svg: buffer.toString('utf8') } : { buffer }
  const p = await probe(input)

  const canvasLong = Math.max(p.canvas.width, p.canvas.height)
  const contentLong = Math.max(p.content.w, p.content.h)

  console.log(`\n=== ${file.split(/[\\/]/).pop()} ===`)
  console.log(`画布        : ${p.canvas.width}×${p.canvas.height} ${p.canvas.transparent ? '透明' : toHex(p.canvas.color)}`)
  console.log(
    `底板        : ${
      p.tile
        ? `${toHex(p.tile.color)} ${p.tile.w}×${p.tile.h} 圆角 ${p.tile.radius}px(占边长 ${((p.tile.radius / Math.max(p.tile.w, p.tile.h)) * 100).toFixed(1)}%)`
        : '无'
    }`
  )
  console.log(`主内容      : ${p.content.w}×${p.content.h} @ ${p.content.x},${p.content.y}`)
  console.log(`内容占画布  : ${((contentLong / canvasLong) * 100).toFixed(1)}%`)
}

;(async () => {
  for (const file of process.argv.slice(2)) {
    try {
      await analyze(file)
    } catch (e) {
      console.log(`\n=== ${file} === 失败: ${e.message}`)
    }
  }
})()
