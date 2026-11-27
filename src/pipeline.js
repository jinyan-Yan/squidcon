'use strict'

/**
 * 把"参考图的样式"套到"目标图"上的总入口。
 *
 * 输入:目标图、参考图(可空)、输出尺寸
 * 输出:SVG 文本 或 PNG 的 base64,外加一份给人看的诊断数据
 */

const { probe } = require('./probe')
const { styleFromProbe, defaultStyle, applyToRaster, applyToSvg } = require('./style')

/**
 * 结构探测缓存。
 * 同一张图的探测结果不会因为换参考而改变,但换一次参考会把所有图重算一遍 ——
 * 不缓存的话每张图每次都要重新渲染 + 逐像素扫描,这是卡顿的主因。
 *
 * 每条缓存约 1MB(512×512×4 的原始像素),上限 32 条。
 */
const probeCache = new Map()
const PROBE_CACHE_MAX = 32

async function probeCached(input, key) {
  if (!input) return null
  if (key && probeCache.has(key)) return probeCache.get(key)

  const result = await probe(input)

  if (key) {
    if (probeCache.size >= PROBE_CACHE_MAX) {
      probeCache.delete(probeCache.keys().next().value)
    }
    probeCache.set(key, result)
  }
  return result
}

// 只取 RGB 三通道:探测出来的颜色可能带 alpha,别把它印到界面上
const toHex = (rgb) =>
  rgb ? '#' + rgb.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase() : null

/**
 * @param {object} options
 * @param {{svg?:string, buffer?:Buffer}} options.target
 * @param {{svg?:string, buffer?:Buffer}|null} options.reference
 * @param {number} [options.outSize]
 * @param {number} [options.ratioOverride] 手动覆盖内容占比
 */
async function convertImage({
  target,
  reference,
  targetKey,
  referenceKey,
  outSize = 512,
  ratioOverride,
  format = 'auto',
}) {
  if (!target) throw new Error('没有目标图')

  const targetProbe = await probeCached(target, targetKey)
  const refProbe = await probeCached(reference, referenceKey)
  const style = refProbe ? styleFromProbe(refProbe, ratioOverride) : defaultStyle(ratioOverride ?? 0.8)

  const isSvg = target.svg != null
  // 只有「选了 SVG(或自动) + 源是 SVG + 源画布透明」才走矢量路线。
  // 位图永远变不成矢量;带不透明画布的 SVG 矢量路线处理不掉,同样退回位图。
  const wantVector = format !== 'png'
  const useVector = wantVector && isSvg && targetProbe.canvas.transparent

  const report = {
    source: {
      format: isSvg ? 'svg' : 'png',
      canvasTransparent: targetProbe.canvas.transparent,
      hasTile: Boolean(targetProbe.tile),
      tileColor: toHex(targetProbe.tile && targetProbe.tile.color),
      radiusRatio: targetProbe.tile
        ? Number(
            (targetProbe.tile.radius / Math.max(1, Math.min(targetProbe.tile.w, targetProbe.tile.h))).toFixed(3)
          )
        : 0,
      contentRatio: Number(
        (
          Math.max(targetProbe.content.w, targetProbe.content.h) /
          Math.max(targetProbe.canvas.width, targetProbe.canvas.height)
        ).toFixed(4)
      ),
    },
    applied: {
      contentRatio: style.contentRatio,
      hasTile: Boolean(style.tile),
      tileColor: toHex(style.tile && style.tile.color),
      radiusRatio: style.tile ? Number(style.tile.radiusRatio.toFixed(3)) : 0,
      canvasTransparent: style.canvasTransparent,
      canvasColor: toHex(style.canvasColor),
    },
    fromReference: Boolean(refProbe),
    vector: useVector,
  }

  if (useVector) {
    return {
      ok: true,
      format: 'svg',
      svg: applyToSvg(target.svg, targetProbe, style, outSize),
      report,
    }
  }

  const png = await applyToRaster(targetProbe, style, outSize)
  return {
    ok: true,
    format: 'png',
    pngBase64: png.toString('base64'),
    report,
  }
}

module.exports = { convertImage }
