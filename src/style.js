'use strict'

/**
 * 样式 = 从参考图里量出来的那组数字。
 *
 * 它不包含任何图形本身,只描述"怎么摆":
 *   canvas   画布是透明的还是实色
 *   tile     有没有圆角底板、多大、多圆、什么颜色
 *   content  主内容占画布的比例
 *
 * 把同一份样式套到另一张图上,两张图渲染出来主内容视觉大小就一致了。
 */

const sharp = require('sharp')
const { colorClose, ALPHA_MIN } = require('./probe')

/* ------------------------------------------------------------------ *
 * 一、从结构探测结果里读样式
 * ------------------------------------------------------------------ */

/**
 * @param {object} p   probe() 的返回值
 * @param {number} [ratioOverride] 手动指定内容占比(不传就用参考图实测值)
 */
function styleFromProbe(p, ratioOverride) {
  const canvasLong = Math.max(p.canvas.width, p.canvas.height)
  const contentLong = Math.max(p.content.w, p.content.h)

  return {
    canvasTransparent: p.canvas.transparent,
    canvasColor: p.canvas.color,
    tile: p.tile
      ? {
          wRatio: p.tile.w / p.canvas.width,
          hRatio: p.tile.h / p.canvas.height,
          radiusRatio: p.tile.radius / Math.max(1, Math.min(p.tile.w, p.tile.h)),
          color: p.tile.color,
        }
      : null,
    contentRatio:
      ratioOverride != null ? ratioOverride : Number((contentLong / canvasLong).toFixed(4)),
  }
}

/** 没有参考图时的兜底样式:透明画布、无底板、内容占 80% */
function defaultStyle(ratio = 0.8) {
  return {
    canvasTransparent: true,
    canvasColor: null,
    tile: null,
    contentRatio: ratio,
  }
}

/* ------------------------------------------------------------------ *
 * 二、套到目标图(位图路线)
 * ------------------------------------------------------------------ */

/**
 * 把目标图的主内容抠出来,去掉源背景色和源底板色。
 * 返回 { buffer, width, height } 的 RGBA 原始像素。
 */
function extractContent(targetProbe) {
  const { raster, content, canvas, tile } = targetProbe
  const { data, width, channels } = raster

  const remove = []
  if (!canvas.transparent && canvas.color) remove.push(canvas.color)
  if (tile && tile.color) remove.push(tile.color)

  const w = content.w
  const h = content.h
  const buffer = Buffer.alloc(w * h * 4)

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = ((content.y + y) * width + (content.x + x)) * channels
      const di = (y * w + x) * 4
      const a = data[si + 3]

      if (a <= ALPHA_MIN) continue

      const rgb = [data[si], data[si + 1], data[si + 2]]
      if (remove.some((bg) => colorClose(rgb, bg))) continue

      buffer[di] = data[si]
      buffer[di + 1] = data[si + 1]
      buffer[di + 2] = data[si + 2]
      buffer[di + 3] = a
    }
  }

  return { buffer, width: w, height: h }
}

/**
 * 位图路线:输出一张 PNG
 * @returns {Promise<Buffer>}
 */
async function applyToRaster(targetProbe, style, outSize) {
  const S = outSize
  const content = extractContent(targetProbe)

  // 1. 主内容缩放到目标占比
  const targetLong = Math.max(1, style.contentRatio * S)
  const k = targetLong / Math.max(content.width, content.height)
  const cw = Math.max(1, Math.round(content.width * k))
  const ch = Math.max(1, Math.round(content.height * k))

  const contentPng = await sharp(content.buffer, {
    raw: { width: content.width, height: content.height, channels: 4 },
  })
    .resize(cw, ch, { fit: 'fill', kernel: 'lanczos3' })
    .png()
    .toBuffer()

  // 2. 依次叠:画布底 → 底板 → 主内容
  const layers = []

  if (style.tile) {
    const tw = Math.round(style.tile.wRatio * S)
    const th = Math.round(style.tile.hRatio * S)
    const tx = Math.round((S - tw) / 2)
    const ty = Math.round((S - th) / 2)
    const r = Math.round(style.tile.radiusRatio * Math.min(tw, th))
    const [cr, cg, cb] = style.tile.color

    const tileSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">
      <rect x="${tx}" y="${ty}" width="${tw}" height="${th}" rx="${r}" ry="${r}" fill="rgb(${cr},${cg},${cb})"/>
    </svg>`
    layers.push({ input: Buffer.from(tileSvg), left: 0, top: 0 })
  }

  layers.push({
    input: contentPng,
    left: Math.max(0, Math.round((S - cw) / 2)),
    top: Math.max(0, Math.round((S - ch) / 2)),
  })

  const background = style.canvasTransparent
    ? { r: 0, g: 0, b: 0, alpha: 0 }
    : {
        r: style.canvasColor[0],
        g: style.canvasColor[1],
        b: style.canvasColor[2],
        alpha: 1,
      }

  return sharp({ create: { width: S, height: S, channels: 4, background } })
    .composite(layers)
    .png()
    .toBuffer()
}

/* ------------------------------------------------------------------ *
 * 三、套到目标图(SVG 路线,保留矢量)
 * ------------------------------------------------------------------ */

function parseViewBox(value) {
  if (!value) return null
  const n = String(value).trim().split(/[\s,]+/).map(Number)
  if (n.length !== 4 || n.some((x) => !Number.isFinite(x))) return null
  if (n[2] <= 0 || n[3] <= 0) return null
  return { x: n[0], y: n[1], w: n[2], h: n[3] }
}

function parseLength(value) {
  if (value == null) return null
  const m = String(value).trim().match(/^([\d.]+)\s*(px)?$/i)
  return m ? parseFloat(m[1]) : null
}

function readAttr(tag, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*(["'])([^"']*)\\1`, 'i')
  const m = tag.match(re)
  return m ? m[2] : null
}

/**
 * SVG 路线。前提:源图本身没有不透明画布(图标一般是透明的)。
 * 有底色的 SVG 走位图路线,见 pipeline.js 里的判断。
 */
function applyToSvg(targetSvg, targetProbe, style, outSize) {
  const S = outSize
  const openMatch = targetSvg.match(/<svg\b[^>]*>/i)
  if (!openMatch) throw new Error('不是有效的 SVG:找不到 <svg> 标签')
  const openTag = openMatch[0]

  const vb =
    parseViewBox(readAttr(openTag, 'viewBox')) ||
    (() => {
      const w = parseLength(readAttr(openTag, 'width'))
      const h = parseLength(readAttr(openTag, 'height'))
      return w && h ? { x: 0, y: 0, w, h } : null
    })()
  if (!vb) throw new Error('这个 SVG 没有 viewBox,无法确定坐标系')

  // 探测位图 → 用户单位
  const scaleX = vb.w / targetProbe.raster.width
  const scaleY = vb.h / targetProbe.raster.height

  const c = targetProbe.content
  const cw = c.w * scaleX
  const ch = c.h * scaleY
  const ccx = vb.x + (c.x + c.w / 2) * scaleX
  const ccy = vb.y + (c.y + c.h / 2) * scaleY

  const k = (style.contentRatio * S) / Math.max(cw, ch)
  const tx = S / 2 - k * ccx
  const ty = S / 2 - k * ccy

  // 原根节点上会继承给子元素的属性(fill/stroke/style 等)要保留,
  // 但尺寸相关的属性必须换掉。
  let rootAttrs = openTag
    .replace(/^<svg\b/i, '')
    .replace(/\/?>$/, '')
    .replace(/\s(viewBox|width|height|preserveAspectRatio)\s*=\s*(["'])[^"']*\2/gi, '')
    .trim()
  if (!/xmlns\s*=/.test(rootAttrs)) {
    rootAttrs = `xmlns="http://www.w3.org/2000/svg" ${rootAttrs}`.trim()
  }

  const inner = targetSvg.slice(openMatch.index + openTag.length, targetSvg.lastIndexOf('</svg>'))

  const parts = [`<svg ${rootAttrs} viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">`]

  if (!style.canvasTransparent && style.canvasColor) {
    const [r, g, b] = style.canvasColor
    parts.push(`<rect x="0" y="0" width="${S}" height="${S}" fill="rgb(${r},${g},${b})"/>`)
  }

  if (style.tile) {
    const tw = style.tile.wRatio * S
    const th = style.tile.hRatio * S
    const rx = Math.round((S - tw) / 2)
    const ry = Math.round((S - th) / 2)
    const radius = style.tile.radiusRatio * Math.min(tw, th)
    const [r, g, b] = style.tile.color
    parts.push(
      `<rect x="${rx.toFixed(2)}" y="${ry.toFixed(2)}" width="${tw.toFixed(2)}" height="${th.toFixed(2)}" ` +
        `rx="${radius.toFixed(2)}" ry="${radius.toFixed(2)}" fill="rgb(${r},${g},${b})"/>`
    )
  }

  parts.push(
    `<g transform="translate(${tx.toFixed(4)} ${ty.toFixed(4)}) scale(${k.toFixed(6)})">${inner}</g>`
  )
  parts.push('</svg>')

  return parts.join('\n')
}

module.exports = {
  styleFromProbe,
  defaultStyle,
  applyToRaster,
  applyToSvg,
  extractContent,
}
