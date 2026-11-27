'use strict'

/**
 * 结构探测:把一张图标拆成三层
 *
 *     画布(最外层背景)  →  底板(可选的圆角矩形)  →  主内容(图标本体)
 *
 * 之所以要分三层,是因为"样式"其实就藏在这三层的关系里:
 *   - 画布:透明还是实色
 *   - 底板:有没有、什么颜色、占画布多大、圆角多大
 *   - 主内容:占画布多大
 *
 * 想统一两张图标的视觉大小,就是把这三层参数从参考图搬到目标图上。
 */

const { Resvg } = require('@resvg/resvg-js')
const sharp = require('sharp')

// 探测分辨率。512 已经够用:内容占比的分辨率误差在 0.2% 以内,
// 但渲染和逐像素扫描的代价只有 1024 的四分之一。
const PROBE = 512
const NEAR = 12 // RGB 各通道差在这以内算同色
const ALPHA_MIN = 24 // alpha 不超过这个算透明(要压过底板外那圈 alpha≈8 的淡光晕)
const TILE_FILL_MIN = 0.85 // 填充率超过这个才可能是底板(圆是 0.785,圆角矩形是 0.95+)

function colorClose(a, b) {
  return Math.abs(a[0] - b[0]) <= NEAR && Math.abs(a[1] - b[1]) <= NEAR && Math.abs(a[2] - b[2]) <= NEAR
}

/** 把任意输入统一成 RGBA 原始像素,方便逐像素分析 */
async function toRgba(input) {
  if (input.svg != null) {
    const png = new Resvg(input.svg, {
      fitTo: { mode: 'width', value: PROBE },
      background: 'rgba(0,0,0,0)',
    })
      .render()
      .asPng()
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    return { data, width: info.width, height: info.height, channels: info.channels }
  }

  const meta = await sharp(input.buffer).metadata()
  let pipeline = sharp(input.buffer)
  if (Math.max(meta.width || 0, meta.height || 0) > PROBE) {
    pipeline = pipeline.resize(PROBE, PROBE, { fit: 'inside' })
  }
  const { data, info } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height, channels: info.channels }
}

/**
 * @param {{svg?:string, buffer?:Buffer}} input
 * @returns {Promise<object>} 结构描述
 */
async function probe(input) {
  const raster = await toRgba(input)
  const { data, width, height, channels } = raster

  const px = (x, y) => {
    const i = (y * width + x) * channels
    return [data[i], data[i + 1], data[i + 2], data[i + 3]]
  }

  /* --- 1. 画布背景 = 边框上出现最多的颜色 --- */
  const tally = new Map()
  const tallyBorder = (x, y) => {
    const c = px(x, y)
    const key = `${c[0]},${c[1]},${c[2]},${c[3]}`
    const hit = tally.get(key)
    if (hit) hit.n++
    else tally.set(key, { n: 1, c })
  }
  for (let x = 0; x < width; x += 4) {
    tallyBorder(x, 0)
    tallyBorder(x, height - 1)
  }
  for (let y = 0; y < height; y += 4) {
    tallyBorder(0, y)
    tallyBorder(width - 1, y)
  }
  const bgEntry = [...tally.values()].sort((a, b) => b.n - a.n)[0]
  const bg = bgEntry.c
  const canvasTransparent = bg[3] <= ALPHA_MIN

  const isCanvasBg = canvasTransparent
    ? (c) => c[3] <= ALPHA_MIN
    : (c) => c[3] <= ALPHA_MIN || colorClose(c, bg)

  /* --- 2. 去掉画布背景后剩下的第一层 --- */
  const bboxOf = (keep, region) => {
    const rx0 = region ? region.x : 0
    const ry0 = region ? region.y : 0
    const rx1 = region ? region.x + region.w - 1 : width - 1
    const ry1 = region ? region.y + region.h - 1 : height - 1

    let x0 = width, y0 = height, x1 = -1, y1 = -1, n = 0
    for (let y = ry0; y <= ry1; y++) {
      for (let x = rx0; x <= rx1; x++) {
        if (keep(px(x, y))) {
          n++
          if (x < x0) x0 = x
          if (x > x1) x1 = x
          if (y < y0) y0 = y
          if (y > y1) y1 = y
        }
      }
    }
    if (x1 < 0) return null
    return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, count: n }
  }

  const layer1 = bboxOf((c) => !isCanvasBg(c))
  if (!layer1) throw new Error('这张图是空的,没有可识别的内容')

  /* --- 3. 第一层是底板还是主内容?--- */
  const fill = layer1.count / (layer1.w * layer1.h)
  const sizeVsCanvas = Math.max(layer1.w, layer1.h) / Math.max(width, height)

  let tile = null
  if (fill >= TILE_FILL_MIN && sizeVsCanvas >= 0.5 && sizeVsCanvas <= 0.99) {
    // 取样几处,取出现最多的那个颜色作为底板色(避开可能存在的描边)
    const samples = [
      px(Math.round(layer1.x + layer1.w / 2), layer1.y + 3),
      px(layer1.x + 3, Math.round(layer1.y + layer1.h / 2)),
      px(Math.round(layer1.x + layer1.w / 2), layer1.y + layer1.h - 4),
      px(layer1.x + layer1.w - 4, Math.round(layer1.y + layer1.h / 2)),
    ]
    let tileColor = samples[0]
    let best = -1
    for (const s of samples) {
      const n = samples.filter((o) => colorClose(o, s)).length
      if (n > best) {
        best = n
        tileColor = s
      }
    }

    // 圆角:从顶边往下扫,左边第一个"碰到 x0"的行,说明圆角到此结束
    let radius = 0
    const limit = Math.min(layer1.h, Math.round(layer1.w * 0.5))
    for (let d = 0; d < limit; d++) {
      const y = layer1.y + d
      let firstX = -1
      for (let x = layer1.x; x <= layer1.x + layer1.w - 1; x++) {
        if (!isCanvasBg(px(x, y))) {
          firstX = x
          break
        }
      }
      if (firstX === layer1.x) {
        radius = d
        break
      }
    }

    tile = {
      x: layer1.x,
      y: layer1.y,
      w: layer1.w,
      h: layer1.h,
      radius,
      color: tileColor,
      fill,
    }
  }

  /* --- 4. 主内容 --- */
  const isTileColor = tile ? (c) => colorClose(c, tile.color) : () => false

  // 有底板时,内容只在底板"内部"找。底板圆角的抗锯齿像素是薄荷色和透明的混合,
  // 颜色对不上底板色,会被误当成内容,把 bbox 撑大到整个底板 —— 必须排除这圈边缘。
  let core = null
  if (tile) {
    const guard = Math.max(3, Math.round(Math.min(tile.w, tile.h) * 0.02))
    core = {
      x: tile.x + guard,
      y: tile.y + guard,
      w: Math.max(1, tile.w - guard * 2),
      h: Math.max(1, tile.h - guard * 2),
    }
  }

  let content = bboxOf((c) => !isCanvasBg(c) && !isTileColor(c), core)
  // 拿不到第二层(比如图标颜色和底板一样),退回第一层
  if (!content || content.w < 2 || content.h < 2) content = tile || layer1

  return {
    raster,
    canvas: {
      transparent: canvasTransparent,
      color: canvasTransparent ? null : [bg[0], bg[1], bg[2]],
      width,
      height,
    },
    tile,
    content,
  }
}

module.exports = { probe, colorClose, ALPHA_MIN }
