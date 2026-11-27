'use strict'

/**
 * 用项目自己的渲染能力把 logo.svg 转成 Windows 图标 icon.ico。
 *
 * ICO 其实是个目录 + 一堆位图。Vista 以后允许每张位图直接存 PNG,
 * 所以这里渲染出多个尺寸的 PNG,再按 ICO 的目录结构拼起来即可,
 * 不需要额外的图标库。
 *
 * 运行: node build/make-icon.js
 */

const fs = require('fs')
const path = require('path')
const { Resvg } = require('@resvg/resvg-js')

const SIZES = [16, 24, 32, 48, 64, 128, 256]
const svgPath = path.join(__dirname, 'logo.svg')
const outPath = path.join(__dirname, 'icon.ico')

const svg = fs.readFileSync(svgPath, 'utf8')

const pngs = SIZES.map((size) => ({
  size,
  data: new Resvg(svg, {
    fitTo: { mode: 'width', value: size },
    background: 'rgba(0,0,0,0)',
  })
    .render()
    .asPng(),
}))

/* --- 拼 ICO --- */

const HEADER_SIZE = 6
const ENTRY_SIZE = 16

const header = Buffer.alloc(HEADER_SIZE)
header.writeUInt16LE(0, 0) // reserved
header.writeUInt16LE(1, 2) // type: 1 = icon
header.writeUInt16LE(pngs.length, 4) // 图片张数

const entries = []
let offset = HEADER_SIZE + ENTRY_SIZE * pngs.length

for (const { size, data } of pngs) {
  const entry = Buffer.alloc(ENTRY_SIZE)
  entry.writeUInt8(size >= 256 ? 0 : size, 0) // width,256 用 0 表示
  entry.writeUInt8(size >= 256 ? 0 : size, 1) // height
  entry.writeUInt8(0, 2) // 调色板颜色数,真彩色填 0
  entry.writeUInt8(0, 3) // reserved
  entry.writeUInt16LE(1, 4) // color planes
  entry.writeUInt16LE(32, 6) // 每像素位数
  entry.writeUInt32LE(data.length, 8) // 该图的字节数
  entry.writeUInt32LE(offset, 12) // 该图在文件里的起始位置
  entries.push(entry)
  offset += data.length
}

fs.writeFileSync(outPath, Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]))

// 顺手导一张 256 PNG,给开发模式的窗口图标用(打包时由 electron-builder 从 ico 生成)
const pngPath = path.join(__dirname, 'icon.png')
fs.writeFileSync(pngPath, pngs[pngs.length - 1].data)

console.log(`已生成 ${outPath}`)
console.log(`包含尺寸: ${SIZES.join(', ')}`)
console.log(`文件大小: ${(fs.statSync(outPath).size / 1024).toFixed(1)} KB`)
console.log(`窗口图标: ${pngPath}`)
